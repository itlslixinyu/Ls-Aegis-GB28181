import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {openStore} from './lib/store.mjs';
import {Access} from './services/access.mjs';
import {AiSettings} from './ai/settings.mjs';
import {AiService} from './ai/service.mjs';
import {AlarmAnalysis} from './ai/alarm-analysis.mjs';
import {normalizeQwenCaption,normalizeQwenInventory,normalizeQwenAssessment,uncertainQwenCaption,opticalQuality,unresolvedGlare,QwenRunner,QWEN_MODEL,QWEN_PROFILES} from './ai/qwen-runner.mjs';
import {sameAlarmScene} from './ai/alarm-similarity.mjs';
async function fixture(t,{runner}={}){
 const {db}=openStore(':memory:');let time=Date.now(),available=5*1024**3;
 db.exec("INSERT INTO users VALUES('a','admin','unused','admin'),('u','analyst','unused','viewer');INSERT INTO devices(id,deviceId,name,createdAt) VALUES('d','34020000001320000001','测试海康','now');INSERT INTO channels VALUES('c','d','34020000001320000001','通道','online');INSERT INTO user_groups VALUES('u','default');");
 db.prepare("INSERT INTO platform_roles(id,name,permissions,createdAt) VALUES('analyst','分析员',?,'now')").run(JSON.stringify(['devices.view','ai.view','ai.analyze','alarms.view']));db.exec("UPDATE user_authorizations SET roleId='analyst' WHERE userId='u'");
 const settings=new AiSettings({envKey:''});settings.save({...settings.public(),localEnabled:true,qwenAlarmEnabled:true,enabled:false},{userId:'a'});
 settings.state.qwenAlarmEnabledAt=new Date(time+86400000).toISOString();
 const client={analyze:()=>{throw Error('unexpected cloud call')}};
 const ai=new AiService({db,access:new Access(db),settings,client,now:()=>time});
 const calls=[];
 const queue=new AlarmAnalysis(ai,{autoStart:false,now:()=>time,memory:()=>available,runner:runner||{ready:()=>true,run:async(image,signal)=>{calls.push(image);return {result:normalizeQwenCaption('描述：一人穿深色上衣，手在嘴边，位于室内。\n标签：深色上衣，室内，手在嘴边，海康测试摄像机，不确定'),model:QWEN_MODEL,metrics:{elapsedMs:10}};}}});ai.alarmAnalysis=queue;
 t.after(()=>ai.close().then(()=>db.close()));
 const image=await sharp({create:{width:64,height:32,channels:3,background:'blue'}}).jpeg().toBuffer();
 function add(id,capturedAt=new Date(time).toISOString(),snapshotId=id){
  db.prepare("INSERT OR IGNORE INTO alarm_snapshots VALUES(?,'ready',NULL,?,?,?)").run(snapshotId,capturedAt,capturedAt,image);
  db.prepare("INSERT INTO alarms(id,deviceId,deviceName,targetCode,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint) VALUES(?,'d','海康','34020000001320000001',4,'5','2','',?,?,?,?)").run(id,capturedAt,capturedAt,capturedAt,id);
  db.prepare('INSERT INTO alarm_snapshot_links VALUES(?,?)').run(id,snapshotId);
 }
 return {db,ai,queue,settings,calls,add,advance:ms=>time+=ms,setMemory:n=>available=n};
}
test('本地告警分析：同图幂等、无云密钥生成记录、图片时间保留、描述可搜索',async t=>{
 const f=await fixture(t);f.add('event-1');f.add('event-2',undefined,'event-1');
 const [one,two]=await Promise.all([f.queue.enqueue('a','event-1'),f.queue.enqueue('a','event-2')]);assert.equal(one.id,two.id);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_jobs').get().n,1);
 await f.ai.drain();assert.equal(f.ai.get('a',one.id).status,'queued');
 await f.queue.tick();await f.queue.current.promise;const job=f.ai.get('a',one.id);assert.equal(job.status,'succeeded');assert.equal(job.alarm.snapshotId,'event-1');assert.equal(job.channelId,'c');assert.deepEqual(job.result.tags,['深色上衣','室内','手在嘴边']);assert.equal(f.calls.length,1);
 assert.equal(f.ai.search('a',{text:'深色上衣'}).items[0].id,job.id);assert.equal(f.ai.list('a',{q:'室内'}).items[0].id,job.id);assert.ok(f.ai.image('a',job.id).length);
 assert.equal(f.ai.get('u',job.id).id,job.id);f.db.exec("DELETE FROM user_groups WHERE userId='u'");assert.throws(()=>f.ai.get('u',job.id),/不存在|无权/);assert.equal(f.ai.search('u',{text:'室内'}).total,0);
});
test('资源不足等待、单任务及全局启动间隔保护、不会操作现有媒体源',async t=>{
 let release;const calls=[];const f=await fixture(t,{runner:{ready:()=>true,run:async()=>{calls.push(1);await new Promise(r=>release=r);return {result:{summary:'室内人物',tags:['室内'],objects:[],observations:[]}};}}});f.add('first',new Date(Date.now()-300000).toISOString());f.add('second');const one=await f.queue.enqueue('a','first'),two=await f.queue.enqueue('a','second');
 f.setMemory(1);await f.queue.tick();assert.equal(f.ai.get('a',one.id).status,'queued');assert.match(f.ai.get('a',one.id).error,/内存/);assert.equal(calls.length,0);
 f.setMemory(5*1024**3);await f.queue.tick();assert.equal(calls.length,1);await f.queue.tick();assert.equal(calls.length,1);const promise=f.queue.current.promise;release();await promise;
 await f.queue.tick();assert.equal(calls.length,1);f.advance(60001);await f.queue.tick();assert.equal(calls.length,2);const next=f.queue.current.promise;release();await next;assert.equal(f.ai.get('a',two.id).status,'succeeded');assert.equal(f.db.prepare('SELECT count(*) n FROM live_sessions').get().n,0);
});
test('自动采样仅处理开启后新图、同通道120秒合并、资源任务中取消与权限撤销',async t=>{
 const f=await fixture(t);f.settings.state.qwenAlarmEnabledAt=new Date(Date.now()-60000).toISOString();f.add('auto-1');f.add('auto-2',undefined,'auto-1');await f.queue.collect();assert.equal(f.db.prepare('SELECT count(*) n FROM ai_jobs').get().n,1);
 f.advance(30000);f.add('too-soon');await f.queue.collect();assert.equal(f.db.prepare('SELECT count(*) n FROM ai_jobs').get().n,1);f.advance(120000);f.add('later');await f.queue.collect();assert.equal(f.db.prepare('SELECT count(*) n FROM ai_jobs').get().n,2);
 f.settings.state.qwenAlarmEnabled=false;await f.queue.tick();assert.equal(f.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status='cancelled'").get().n,2);
 assert.throws(()=>normalizeQwenCaption(''),/有效中文/);
});
test('用户取消运行中的本地任务，关闭回收模型，失败不写伪分析结果',async t=>{
 const f=await fixture(t,{runner:{ready:()=>true,run:async(_,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}});f.add('cancel');const job=await f.queue.enqueue('a','cancel');await f.queue.tick();const work=f.queue.current.promise;f.ai.cancel('a',job.id);await work;assert.equal(f.ai.get('a',job.id).status,'cancelled');assert.equal(f.ai.get('a',job.id).result,null);assert.equal(f.queue.current,null);
});
test('多线程分析提前让位于两项录像或四个观看租约',async t=>{
 const f=await fixture(t);f.queue.runner.profile={threads:4};
 const insertRecording=f.db.prepare("INSERT INTO recording_jobs(id,ownerId,channelId,kind,status,deadline,createdAt) VALUES(?,'a','c','scheduled','recording',?,'now')");
 insertRecording.run('guard-r1',Date.now()+60000);assert.equal(f.queue.resourceReason(),null);
 insertRecording.run('guard-r2',Date.now()+60000);assert.match(f.queue.resourceReason(),/预览和录像优先/);
 f.db.exec("UPDATE recording_jobs SET status='cancelled' WHERE id='guard-r2';INSERT INTO live_sessions(id,channelId,deviceId,streamId,state,createdAt) VALUES('guard-s','c','d','guard-stream','ready','now')");
 const insertViewer=f.db.prepare("INSERT INTO viewers(id,sessionId,userId,expiresAt) VALUES(?,'guard-s','a',?)");
 for(let i=0;i<3;i++)insertViewer.run('guard-v'+i,Date.now()+60000);assert.equal(f.queue.resourceReason(),null);
 insertViewer.run('guard-v3',Date.now()+60000);f.add('guard-event');const job=await f.queue.enqueue('a','guard-event');await f.queue.tick();assert.equal(f.ai.get('a',job.id).status,'queued');assert.equal(f.calls.length,0);assert.match(f.queue.resourceReason(),/预览和录像优先/);
});

test('高视觉预算按配置预留启动内存，不在不足时启动后反复中断',async t=>{
 const f=await fixture(t);f.queue.runner.profile={threads:2,startMemoryMiB:3584};f.add('memory-budget');
 const job=await f.queue.enqueue('a','memory-budget');f.setMemory(3400*1048576);await f.queue.tick();assert.equal(f.calls.length,0);assert.equal(f.ai.get('a',job.id).status,'queued');
 f.setMemory(3700*1048576);await f.queue.tick();await f.queue.current.promise;assert.equal(f.calls.length,1);assert.equal(f.ai.get('a',job.id).status,'succeeded');
});
test('运行中权限撤销回收任务并清空图片；资源让出后可以恢复同一条记录',async t=>{
 let count=0;const f=await fixture(t,{runner:{ready:()=>true,run:async(_,signal)=>{if(++count===2)return {result:{summary:'室内人物',tags:['室内'],objects:[],observations:[]}};return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
 f.add('resource');const job=await f.queue.enqueue('a','resource');await f.queue.tick();const work=f.queue.current.promise;f.setMemory(1);await f.queue.tick();await work;assert.equal(f.ai.get('a',job.id).status,'queued');f.setMemory(5*1024**3);f.advance(60001);await f.queue.tick();await f.queue.current.promise;assert.equal(f.ai.get('a',job.id).status,'succeeded');assert.equal(count,2);
 f.add('revoke');const revoked=await f.queue.enqueue('u','revoke');f.advance(60001);await f.queue.tick();const pending=f.queue.current.promise;f.db.exec("UPDATE user_authorizations SET roleId='viewer' WHERE userId='u'");await f.queue.tick();await pending;assert.equal(f.db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(revoked.id).status,'failed');assert.equal(f.db.prepare('SELECT image FROM ai_jobs WHERE id=?').get(revoked.id).image,null);
});
test('队列上限与超时明确，标签过滤主观猜测',async t=>{
 const f=await fixture(t);for(let i=0;i<6;i++){f.add('cap-'+i);if(i<5)await f.queue.enqueue('a','cap-'+i);}await assert.rejects(()=>f.queue.enqueue('a','cap-5'),/队列/);
 f.advance(901000);await f.queue.tick();assert.equal(f.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status='failed'").get().n,5);
 const result=normalizeQwenCaption('描述：一人穿深色上衣，似乎在思考或感到惊讶，位于室内。\n标签：室内，思考，海康测试摄像机，深色上衣');assert.equal(result.summary,'一人穿深色上衣，位于室内。');assert.deepEqual(result.tags,['室内','深色上衣']);
 const clean=normalizeQwenCaption('描述：三人站在室内。\n标签：3人，室内，3至6个搜索关键词，3-5个名词');assert.deepEqual(clean.tags,['3人','室内']);
 const grounded=normalizeQwenCaption('描述：人物穿深色上衣，天花板上有吊灯。\n标签：窗帘，深色上衣，天花板，吊灯',{groundTags:true});assert.deepEqual(grounded.tags,['深色上衣','天花板','吊灯']);
 const fabric=normalizeQwenCaption('描述：悬挂的白色褶皱布料，上面有红色小标志。\n标签：悬挂布料，红色标志',{groundTags:true});assert.deepEqual(fabric.tags,['悬挂布料','红色标志']);
});
test('重启恢复15分钟内中断的本地任务，不新建重复记录',async t=>{
 const f=await fixture(t);f.add('restart');const job=await f.queue.enqueue('a','restart');await f.queue.close();f.db.prepare("UPDATE ai_jobs SET status='interrupted',error='平台关闭，排队任务未完成' WHERE id=?").run(job.id);
 const resumed=new AlarmAnalysis(f.ai,{autoStart:false,memory:()=>5*1024**3,runner:{ready:()=>true,run:async()=>({result:{summary:'室内人物',tags:['室内'],objects:[],observations:[]}})}});f.ai.alarmAnalysis=resumed;
 assert.equal(f.ai.get('a',job.id).status,'queued');await resumed.tick();await resumed.current.promise;assert.equal(f.ai.get('a',job.id).status,'succeeded');assert.equal(f.db.prepare('SELECT count(*) n FROM ai_jobs').get().n,1);
});

test('拒绝告警原样错误、提示复述、重复及人车矛盾，不把否定句作为标签',()=>{
 for(const summary of [
  '未见明显人员或车辆，未见明确车辆或颜色、位置、朝向或姿态，未见模糊遮挡，背景为城市道路与建筑。',
  '未见清晰车辆，未见清晰车辆，背景为道路。',
  '未见车辆，道路上有车辆。',
  '没有汽车，路口有多辆汽车。',
 ])assert.throws(()=>normalizeQwenCaption('描述：'+summary+'\n标签：道路'),{code:'QWEN_INVALID_RESULT'});
 const result=normalizeQwenCaption('描述：道路旁有汽车，远处是建筑。\n标签：道路，汽车，未见人员，没有人员',{groundTags:true});
 assert.deepEqual(result.tags,['道路','汽车']);
 for(const raw of ['道路上有多辆汽车。','描述：道路上有汽车。\n标签：未见人员','描述：道路上有汽车。\n标签：汽车，道路，汽车，道路，汽车，道路'])
  assert.throws(()=>normalizeQwenCaption(raw,{groundTags:true}),{code:'QWEN_INVALID_RESULT'});
 assert.equal(normalizeQwenCaption('描述：未见明显人员或车辆，背景为城市道路与建筑。\n标签：道路').summary,'未见明显人员或车辆，背景为城市道路与建筑。');
});

test('结构化物体描述保留模型给出的名称颜色位置，不预填车辆、不生成目标框或计数',()=>{
 const result=normalizeQwenInventory(JSON.stringify({items:[{name:'汽车',color:'白色',position:'画面下方'},{name:'建筑物',color:'灰色',position:'远处'}]}));
 assert.match(result.summary,/汽车（白色，画面下方）/);assert.deepEqual(result.tags,['汽车','白色','建筑物','灰色']);
 assert.deepEqual(result.objects,[]);assert.deepEqual(result.observations,[]);
 const control=normalizeQwenInventory(JSON.stringify({items:[{name:'窗帘',color:'灰色',position:'左侧'},{name:'人物',color:'',position:'右侧'}]}));
 assert.doesNotMatch(control.summary,/汽车|车辆/);assert.ok(control.tags.includes('窗帘'));
 assert.doesNotMatch(QWEN_PROFILES.threads2.prompt,/汽车|车辆/);
 for(const value of ['{}','{"items":[]}','{"items":[{"name":"汽车"}]}','{"items":[{"name":"汽车","color":"白色","position":"下方"}]',JSON.stringify({items:Array.from({length:6},()=>({name:'树木',color:'绿色',position:'左侧'}))})])
  assert.throws(()=>normalizeQwenInventory(value),{code:'QWEN_INVALID_RESULT'});
});

test('结构化实体共享位置和颜色仍能返回，整项重复去重而非虚构计数',()=>{
 const items=[{name:'道路',color:'灰色',position:'画面中下部'},{name:'车辆',color:'白色',position:'画面中下部'},{name:'交通标线',color:'白色',position:'画面中下部'}];
 const result=normalizeQwenInventory(JSON.stringify({items}));assert.match(result.summary,/车辆（白色，画面中下部）/);assert.ok(result.tags.includes('车辆'));
 const duplicate=normalizeQwenInventory(JSON.stringify({items:[items[1],items[1]]}));assert.equal(duplicate.summary.match(/车辆/g).length,1);assert.deepEqual(duplicate.objects,[]);
 assert.throws(()=>normalizeQwenCaption('描述：未见清晰车辆，未见清晰车辆，背景为道路。\n标签：道路'),{code:'QWEN_INVALID_RESULT'});
});

test('时间戳和水印类实体不进入描述，真实时钟与摄像头不被一刀切删除',()=>{
 const result=normalizeQwenInventory(JSON.stringify({items:[{name:'电脑屏幕',color:'紫色',position:'中央'},{name:'时间戳',color:'白色',position:'左上角'},{name:'文字',color:'黑色',position:'右侧'}]}));
 assert.match(result.summary,/电脑屏幕/);assert.doesNotMatch(result.summary,/时间戳|文字/);assert.deepEqual(result.tags,['电脑屏幕','紫色']);
 const clock=normalizeQwenInventory(JSON.stringify({items:[{name:'挂钟',color:'白色',position:'墙上'},{name:'监控摄像头',color:'黑色',position:'顶部'}]}));assert.match(clock.summary,/挂钟/);assert.match(clock.summary,/监控摄像头/);
 const short=normalizeQwenInventory(JSON.stringify({items:[{name:'人',color:'',position:''}]}));assert.equal(short.summary,'可见：人。');
 const dated=normalizeQwenInventory(JSON.stringify({items:[{name:'显示器',color:'白色',position:'2026年11月08日 06:24:00'}]}));assert.doesNotMatch(dated.summary,/2026|06:24/);
 assert.throws(()=>normalizeQwenInventory(JSON.stringify({items:[{name:'时间戳',color:'白色',position:'左上角'}]})),{code:'QWEN_INVALID_RESULT'});
});

test('不清晰画面只记录视觉外观，不能把可辨认的人车改成不确定结果',()=>{
 const assessment=normalizeQwenAssessment(JSON.stringify({scene:'closeup',personVisible:false,vehicleVisible:false,identityClear:false,appearance:'中央有白色亮斑，周围为黑色模糊轮廓'}));
 const result=uncertainQwenCaption(assessment);assert.match(result.summary,/白色亮斑/);assert.match(result.summary,/主体类型不明/);assert.doesNotMatch(result.summary,/车灯|汽车|摄像头/);assert.ok(result.tags.includes('主体类型不明'));
 assert.throws(()=>uncertainQwenCaption({...assessment,personVisible:true}),{code:'QWEN_INVALID_RESULT'});
 assert.throws(()=>uncertainQwenCaption({...assessment,appearance:'中央是汽车的车灯和手机'}),{code:'QWEN_INVALID_RESULT'});
 assert.throws(()=>normalizeQwenAssessment('{"scene":"closeup","personVisible":"false"}'),{code:'QWEN_INVALID_RESULT'});
});

test('两阶段看图使用同一原图；关注要求仅传描述阶段，指标合并且不常驻第二进程',async()=>{
 const runner=new QwenRunner({profile:'candidate',diagnostics:true}),image=await sharp({create:{width:32,height:32,channels:3,background:'gray'}}).jpeg().toBuffer(),calls=[];
 const facts={scene:'wide',personVisible:false,vehicleVisible:true,identityClear:true,appearance:'道路上有白色和深色车辆轮廓'};
 runner.runPass=async(bytes,signal,question,profile)=>{assert.strictEqual(bytes,image);calls.push({question,profile});return profile.assessment?{result:facts,metrics:{elapsedMs:10,peakWorkingSetMiB:2000,privateMiB:1500,cpuSeconds:2},diagnostics:{rawOutput:JSON.stringify(facts)}}:{result:normalizeQwenInventory(JSON.stringify({items:[{name:'车辆',color:'白色',position:'下方'}]})),metrics:{elapsedMs:20,peakWorkingSetMiB:2100,privateMiB:1550,cpuSeconds:3},diagnostics:{rawOutput:'caption'}};};
 const result=await runner.run(image,new AbortController().signal,'关注颜色');assert.equal(calls.length,2);assert.equal(calls[0].question,'');assert.equal(calls[1].question,'关注颜色');assert.match(result.result.summary,/车辆/);assert.equal(result.metrics.passes,2);assert.equal(result.metrics.cpuSeconds,5);assert.equal(result.metrics.peakWorkingSetMiB,2100);assert.deepEqual(result.diagnostics.assessment,facts);
});

test('可见性评估后取消不再启动描述阶段',async()=>{
 const runner=new QwenRunner({profile:'candidate'}),controller=new AbortController();let calls=0;
 runner.runPass=async()=>{calls++;controller.abort(Error('用户取消'));return {result:{scene:'wide',personVisible:true,vehicleVisible:false,identityClear:true,appearance:'右侧可见人物头部'}};};
 await assert.rejects(()=>runner.run(Buffer.from('image'),controller.signal),/用户取消/);assert.equal(calls,1);
});

test('光学不确定性依据像素质量，夜间远景、彩色屏幕、清楚人物及锐利结构不被套用',async()=>{
 const blob=await sharp(Buffer.from('<svg width="256" height="160"><rect width="256" height="160" fill="black"/><rect x="88" y="35" width="80" height="90" rx="20" fill="white"/></svg>')).blur(3).jpeg().toBuffer();
 const q=await opticalQuality(blob),facts={scene:'closeup',personVisible:false,vehicleVisible:true,identityClear:true};assert.equal(unresolvedGlare(facts,q),true);assert.match(q.highlightPosition,/画面/);
 assert.equal(unresolvedGlare({...facts,scene:'wide'},q),false);assert.equal(unresolvedGlare({...facts,personVisible:true},q),false);
 const colorful=await sharp(Buffer.from('<svg width="256" height="160"><rect width="256" height="160" fill="blue"/><rect x="88" y="35" width="80" height="90" fill="white"/></svg>')).jpeg().toBuffer();assert.equal(unresolvedGlare(facts,await opticalQuality(colorful)),false);
 let squares='';for(let y=0;y<10;y++)for(let x=0;x<16;x++)squares+='<rect x="'+x*16+'" y="'+y*16+'" width="16" height="16" fill="'+((x+y)%2?'white':'black')+'"/>';
 const sharpPattern=await sharp(Buffer.from('<svg width="256" height="160">'+squares+'</svg>')).png().toBuffer();assert.equal(unresolvedGlare(facts,await opticalQuality(sharpPattern)),false);
});

test('相近告警复用同账号同通道结果，保留原告警和图片，超过窗口重新分析',async t=>{
 const f=await fixture(t);f.add('scene-a');
 const first=await f.queue.enqueue('a','scene-a');await f.queue.tick();await f.queue.current.promise;
 f.advance(60001);f.add('scene-b');const second=await f.queue.enqueue('a','scene-b');await f.queue.tick();await f.queue.current.promise;
 assert.equal(f.calls.length,1);assert.equal(f.ai.get('a',second.id).usage.similarScene,true);
 assert.equal(f.ai.get('a',second.id).alarm.snapshotId,'scene-b');assert.equal(f.db.prepare('SELECT count(*) n FROM alarms').get().n,2);
 f.advance(60001);f.add('scene-c');const third=await f.queue.enqueue('a','scene-c');await f.queue.tick();await f.queue.current.promise;
 assert.equal(f.calls.length,2);assert.equal(f.ai.get('a',third.id).usage.similarScene,undefined);
 assert.notEqual(first.id,second.id);
});

test('画面比较允许轻微压缩差异，但拒绝小块新目标和明显变化',async()=>{
 const base=await sharp({create:{width:640,height:360,channels:3,background:'#808080'}}).jpeg().toBuffer();
 const compressed=await sharp(base).jpeg({quality:60}).toBuffer();
 assert.equal(await sameAlarmScene(base,compressed),true);
 const target=await sharp({create:{width:20,height:30,channels:3,background:'red'}}).png().toBuffer();
 const changed=await sharp(base).composite([{input:target,left:300,top:150}]).jpeg().toBuffer();
 assert.equal(await sameAlarmScene(base,changed),false);
 const dark=await sharp(base).modulate({brightness:0.7}).jpeg().toBuffer();
 assert.equal(await sameAlarmScene(base,dark),false);
});

test('相似告警不得跨账号复用分析结果',async t=>{
 const f=await fixture(t);f.add('owner-a');const first=await f.queue.enqueue('a','owner-a');
 await f.queue.tick();await f.queue.current.promise;
 f.advance(60001);f.add('owner-u');const second=await f.queue.enqueue('u','owner-u');
 await f.queue.tick();await f.queue.current.promise;
 assert.equal(f.calls.length,2);assert.equal(f.ai.get('u',second.id).usage.cached,undefined);
 assert.notEqual(first.id,second.id);
});

test('显式重分析原图保留ID和图片时间、清除旧结果、跳过相似缓存且重复提交幂等',async t=>{
 const f=await fixture(t);f.add('retry-a');const first=await f.queue.enqueue('a','retry-a');await f.queue.tick();await f.queue.current.promise;
 f.advance(60001);f.add('retry-b');const second=await f.queue.enqueue('a','retry-b');await f.queue.tick();await f.queue.current.promise;
 assert.equal(f.calls.length,1);const before=f.ai.get('a',second.id);assert.equal(before.usage.similarScene,true);
 await assert.rejects(()=>f.queue.enqueue('u','retry-b',{reanalyze:true}),{code:'QWEN_REANALYZE_FORBIDDEN'});
 const retry=await f.queue.enqueue('a','retry-b',{reanalyze:true});assert.equal(retry.id,second.id);assert.equal(retry.status,'queued');assert.equal(retry.result,null);assert.equal(retry.capturedAt,before.capturedAt);
 assert.equal((await f.queue.enqueue('a','retry-b',{reanalyze:true})).id,second.id);
 await f.queue.tick();assert.equal(f.queue.current,null,'重分析也遵守60秒全局启动间隔');
 f.advance(60001);await f.queue.tick();await f.queue.current.promise;
 const done=f.ai.get('a',second.id);assert.equal(done.status,'succeeded');assert.equal(done.usage.reanalysis,true);assert.equal(done.usage.cached,undefined);assert.equal(f.calls.length,2);assert.equal(done.capturedAt,before.capturedAt);assert.equal(f.db.prepare('SELECT count(*) n FROM ai_jobs').get().n,2);assert.deepEqual(f.ai.image('a',second.id),f.calls[1]);
});
