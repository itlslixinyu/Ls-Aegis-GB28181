import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {monitoringFixture} from './test-support/monitoring-fixture.mjs';
import {AiSettings} from './ai/settings.mjs';
test('告警Qwen HTTP：操作者归属、CSRF、只分析已有图、记录搜索和撤权',async t=>{
 const settings=new AiSettings({envKey:''});let calls=0;
 const f=await monitoringFixture({aiSettings:settings,qwenOptions:{memory:()=>5*1024**3,runner:{ready:()=>true,run:async()=>{calls++;return {result:{summary:'室内一人穿深色上衣',tags:['室内','深色上衣'],objects:[],observations:[]},metrics:{elapsedMs:4}};}}}});t.after(()=>f.close());
 async function login(username){const r=await fetch(f.base+'/api/v1/auth/login',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({username,password:f.password})});assert.equal(r.status,200);const j=await r.json();return {Cookie:r.headers.get('set-cookie').split(';')[0],Origin:f.base,'Content-Type':'application/json','X-CSRF-Token':j.data.csrf};}
 const admin=await login('qa-admin'),viewer=await login('qa-monitor');
 async function call(path,headers=admin,method='GET',body){const r=await fetch(f.base+'/api/v1'+path,{headers,method,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,json:await r.json()};}
 assert.equal((await call('/ai/alarm-analyses',viewer,'POST',{alarmId:'visible'})).status,403);
 assert.equal((await call('/ai/alarm-analyses',{...admin,'X-CSRF-Token':'wrong'},'POST',{alarmId:'visible'})).status,403);
 const saved=await call('/ai/settings',admin,'PUT',{...settings.public(),qwenAlarmEnabled:true,qwenAlarmOwnerId:'forged-owner',qwenAlarmIntervalSeconds:120});assert.equal(saved.status,200);assert.equal(settings.state.qwenAlarmOwnerId,'qa-admin');assert.equal(JSON.stringify(saved.json).includes('qwenAlarmOwnerId'),false);assert.equal(settings.public().enabled,false);
 settings.state.qwenAlarmEnabledAt=new Date(Date.now()+86400000).toISOString();
 const image=await sharp({create:{width:32,height:32,channels:3,background:'blue'}}).jpeg().toBuffer();
 for(const [id,device] of [['visible','qa-nvr'],['hidden','qa-denied']]){
  const c=f.db.prepare('SELECT channelCode FROM channels WHERE deviceId=? LIMIT 1').get(device);const now=new Date().toISOString();
  f.db.prepare("INSERT INTO alarms(id,deviceId,deviceName,targetCode,priority,method,type,description,occurredAt,receivedAt,lastReceivedAt,fingerprint) VALUES(?,?,?, ?,4,'5','2','',?,?,?,?)").run(id,device,'隔离告警',c.channelCode,now,now,now,id);
  f.db.prepare("INSERT INTO alarm_snapshots VALUES(?,'ready',NULL,?,?,?)").run(id,now,now,image);f.db.prepare('INSERT INTO alarm_snapshot_links VALUES(?,?)').run(id,id);
 }
 const before=f.stats();
 const accepted=await call('/ai/alarm-analyses',admin,'POST',{alarmId:'visible'});assert.equal(accepted.status,202);const id=accepted.json.data.id;
 assert.equal((await call('/ai/alarm-analyses',admin,'POST',{alarmId:'visible'})).json.data.id,id);
 let job;for(let i=0;i<50;i++){job=(await call('/ai/analyses/'+id)).json.data;if(job.status==='succeeded')break;await new Promise(r=>setTimeout(r,100));}assert.equal(job.status,'succeeded');assert.equal(calls,1);assert.equal(job.alarm.alarmId,'visible');
 assert.equal((await call('/alarms/visible')).json.data.analysis.id,id);
 const search=await call('/ai/search',admin,'POST',{text:'深色上衣'});assert.equal(search.status,200);assert.equal(search.json.data.items[0].id,id);assert.equal((await call('/ai/analyses?q=室内')).json.data.items[0].id,id);
 const after=f.stats();assert.equal(after.planFingerprint,before.planFingerprint);assert.equal(after.nvrViewers,before.nvrViewers);
 assert.equal((await call('/ai/alarm-analyses',admin,'POST',{alarmId:'visible',reanalyze:'yes'})).status,400);
 assert.equal((await call('/ai/alarm-analyses',{...admin,'X-CSRF-Token':'wrong'},'POST',{alarmId:'visible',reanalyze:true})).status,403);
 f.db.prepare('UPDATE alarm_ai_jobs SET startedAt=? WHERE jobId=?').run(new Date(Date.now()-61000).toISOString(),id);
 const retry=await call('/ai/alarm-analyses',admin,'POST',{alarmId:'visible',reanalyze:true});assert.equal(retry.status,202);assert.equal(retry.json.data.id,id);assert.equal(retry.json.data.status,'queued');assert.equal(retry.json.data.result,null);
 for(let i=0;i<50;i++){job=(await call('/ai/analyses/'+id)).json.data;if(job.status==='succeeded')break;await new Promise(r=>setTimeout(r,100));}assert.equal(job.status,'succeeded');assert.equal(calls,2);assert.equal(job.usage.reanalysis,true);
 f.db.prepare("INSERT INTO platform_roles(id,name,permissions,createdAt) VALUES('qa-ai','AI查看',?,'now')").run(JSON.stringify(['devices.view','ai.view','ai.analyze','alarms.view']));f.db.exec("UPDATE user_authorizations SET roleId='qa-ai' WHERE userId='qa-monitor'");
 assert.equal((await call('/ai/analyses/'+id,viewer)).status,200);
 assert.equal((await call('/ai/alarm-analyses',viewer,'POST',{alarmId:'hidden'})).status,404);
 f.db.exec("DELETE FROM user_groups WHERE userId='qa-monitor'");assert.equal((await call('/ai/analyses/'+id,viewer)).status,404);assert.equal((await call('/ai/search',viewer,'POST',{text:'室内'})).json.data.total,0);
});
