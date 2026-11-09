import {randomUUID,createHash} from 'node:crypto';
import {freemem} from 'node:os';
import sharp from 'sharp';
import {QwenRunner,QWEN_MODEL} from './qwen-runner.mjs';
import {sameAlarmScene} from './alarm-similarity.mjs';
import {aiProblem} from './settings.mjs';
export class AlarmAnalysis {
 constructor(ai,{runner=new QwenRunner(),now=()=>Date.now(),memory=freemem,autoStart=true}={}){
  Object.assign(this,{ai,db:ai.db,runner,now,memory});this.current=null;this.closed=false;this.pumping=false;
  this.db.prepare("UPDATE ai_jobs SET status='queued',error='平台重启，等待本地分析恢复',finishedAt=NULL WHERE status='interrupted' AND error LIKE '平台%' AND id IN (SELECT jobId FROM alarm_ai_jobs WHERE queuedAt>?)").run(new Date(this.now()-900000).toISOString());
  if(autoStart){this.timer=setInterval(()=>void this.tick().catch(()=>{}),2000);this.timer.unref();}
 }
 enabled(){return this.ai.settings.state.localEnabled!==false&&this.ai.settings.state.qwenAlarmEnabled===true;}
 authorized(user,deviceId,channelId){return this.ai.access.can(user,'ai.analyze')&&this.ai.access.can(user,'alarms.view')&&this.ai.access.device(user,deviceId)&&this.ai.access.channel(user,channelId);}
 resourceReason(starting=true){
  if(this.memory()<(starting?(this.runner.profile?.startMemoryMiB||3072):1024)*1048576)return '可用内存不足，等待资源';
  if(this.ai.running.size||this.ai.history.running||this.ai.history.index.current)return '其他AI任务优先，等待资源';
  const multithread=(this.runner.profile?.threads||1)>1;
  if(this.db.prepare("SELECT count(*) n FROM recording_jobs WHERE status IN ('starting','recording','finalizing')").get().n>=(multithread?2:4)||this.db.prepare('SELECT count(*) n FROM viewers WHERE expiresAt>?').get(this.now()).n>=(multithread?4:9))return '预览和录像优先，等待资源';
  return null;
 }
 status(){return {enabled:this.enabled(),ready:this.runner.ready(),running:!!this.current,queued:this.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status='queued' AND id IN(SELECT jobId FROM alarm_ai_jobs)").get().n,intervalSeconds:this.ai.settings.state.qwenAlarmIntervalSeconds||120};}
 async enqueue(userId,alarmId,{reanalyze=false}={}){
  if(this.closed||!this.enabled())throw aiProblem(409,'QWEN_DISABLED','请先启用本地接入和Qwen告警自动分析');
  if(!this.runner.ready())throw aiProblem(503,'QWEN_NOT_READY','本地Qwen模型或运行库未就绪');
  this.ai.require(userId,'ai.analyze');
  const row=this.db.prepare("SELECT s.id AS snapshotId,s.image,s.capturedAt,a.id AS alarmId,a.deviceId,d.name,c.id AS channelId FROM alarms a JOIN alarm_snapshot_links l ON l.alarmId=a.id JOIN alarm_snapshots s ON s.id=l.snapshotId JOIN devices d ON d.id=a.deviceId JOIN channels c ON c.deviceId=a.deviceId AND c.channelCode=a.targetCode WHERE a.id=? AND a.method='5' AND a.type='2' AND s.status='ready'").get(alarmId);
  if(!row||!this.authorized(userId,row.deviceId,row.channelId))throw aiProblem(404,'QWEN_ALARM_NOT_FOUND','告警图片不存在或无权分析');
  const existing=this.db.prepare('SELECT jobId FROM alarm_ai_jobs WHERE snapshotId=?').get(row.snapshotId);
  if(existing){
   if(!existing.jobId)throw aiProblem(410,'QWEN_ANALYSIS_EXPIRED','该图片的分析记录已过期，不重复自动分析');
   const job=this.ai.get(userId,existing.jobId);
   if(!reanalyze||['queued','running'].includes(job.status))return job;
   const old=this.db.prepare('SELECT ownerId FROM ai_jobs WHERE id=?').get(existing.jobId);
   if((old.ownerId!==userId&&!this.ai.access.admin(userId))||!this.authorized(old.ownerId,row.deviceId,row.channelId))throw aiProblem(403,'QWEN_REANALYZE_FORBIDDEN','无权重新分析该记录或原归属账号权限已变化');
   if(this.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running') AND id IN(SELECT jobId FROM alarm_ai_jobs)").get().n>=5||this.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running')").get().n>=20)throw aiProblem(429,'QWEN_QUEUE_FULL','本地分析队列已满，等待处理');
   const now=new Date(this.now()).toISOString();
   this.db.exec('BEGIN IMMEDIATE');
   try{
    this.db.prepare("UPDATE ai_jobs SET status='queued',result=NULL,usage=?,error=NULL,finishedAt=NULL,model=?,image=? WHERE id=?").run(JSON.stringify({reanalysis:true}),QWEN_MODEL,row.image,existing.jobId);
    this.db.prepare('UPDATE alarm_ai_jobs SET queuedAt=?,nextAttempt=0 WHERE jobId=?').run(now,existing.jobId);
    this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e;}
   return this.ai.get(userId,existing.jobId);
  }
  const meta=await sharp(Buffer.from(row.image),{limitInputPixels:16000000}).metadata();
  if(this.closed||!this.enabled()||!this.authorized(userId,row.deviceId,row.channelId))throw aiProblem(403,'QWEN_SCOPE_REVOKED','本地分析已停用或设备权限已变化');
  const duplicate=this.db.prepare('SELECT jobId FROM alarm_ai_jobs WHERE snapshotId=?').get(row.snapshotId);if(duplicate)return this.ai.get(userId,duplicate.jobId);
  const count=this.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running') AND id IN(SELECT jobId FROM alarm_ai_jobs)").get().n;
  if(count>=5||this.db.prepare("SELECT count(*) n FROM ai_jobs WHERE status IN ('queued','running')").get().n>=20)throw aiProblem(429,'QWEN_QUEUE_FULL','本地分析队列已满，等待处理');
  const storage=this.db.prepare('SELECT count(*) n,coalesce(sum(length(image)),0) bytes FROM ai_jobs').get();
  if(storage.n>=5000||storage.bytes+row.image.length>512*1024*1024)throw aiProblem(409,'AI_STORAGE_FULL','分析记录存储达到保护上限');
  if(!this.db.prepare("SELECT 1 FROM alarm_snapshots WHERE id=? AND status='ready'").get(row.snapshotId))throw aiProblem(410,'QWEN_SNAPSHOT_EXPIRED','告警图片已过期');
  const id=randomUUID(),now=new Date(this.now()).toISOString(),expiry=new Date(this.now()+this.ai.settings.state.retentionDays*86400000).toISOString();
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare("INSERT INTO ai_jobs(id,ownerId,channelId,sourceName,sourceType,status,question,image,imageHash,width,height,createdAt,capturedAt,expiresAt,model) VALUES(?,?,?,?,'upload','queued',?,?,?,?,?,?,?,?,?)").run(id,userId,row.channelId,'告警抓图 · '+row.name,'本地Qwen告警图片描述与搜索标签',row.image,createHash('sha256').update(row.image).digest('hex'),meta.width,meta.height,now,row.capturedAt,expiry,QWEN_MODEL);
   this.db.prepare('INSERT INTO alarm_ai_jobs(snapshotId,jobId,deviceId,channelId,alarmId,queuedAt,capturedAt) VALUES(?,?,?,?,?,?,?)').run(row.snapshotId,id,row.deviceId,row.channelId,row.alarmId,now,row.capturedAt);
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return this.ai.get(userId,id);
 }
 async collect(){
  const user=this.ai.settings.state.qwenAlarmOwnerId,since=this.ai.settings.state.qwenAlarmEnabledAt;if(!user||!since)return;
  const cutoff=new Date(Math.max(Date.parse(since),this.now()-900000)).toISOString();
  const candidates=this.db.prepare("SELECT s.id,min(a.id) alarmId,s.capturedAt,c.id channelId,a.deviceId FROM alarm_snapshots s JOIN alarm_snapshot_links l ON l.snapshotId=s.id JOIN alarms a ON a.id=l.alarmId JOIN channels c ON c.deviceId=a.deviceId AND c.channelCode=a.targetCode WHERE s.status='ready' AND s.capturedAt>=? AND a.method='5' AND a.type='2' AND NOT EXISTS(SELECT 1 FROM alarm_ai_jobs q WHERE q.snapshotId=s.id) GROUP BY s.id ORDER BY s.capturedAt DESC LIMIT 20").all(cutoff);
  for(const c of candidates){
   if(!this.authorized(user,c.deviceId,c.channelId))continue;
   const last=this.db.prepare('SELECT max(capturedAt) at FROM alarm_ai_jobs WHERE channelId=?').get(c.channelId).at;
   if(last&&Date.parse(c.capturedAt)-Date.parse(last)<(this.ai.settings.state.qwenAlarmIntervalSeconds||120)*1000)continue;
   try{await this.enqueue(user,c.alarmId);}catch(e){if(e.status===429||e.code==='AI_STORAGE_FULL')break;}
  }
 }
 cancel(id){if(this.current?.id===id)this.current.controller.abort(aiProblem(409,'QWEN_CANCELLED','任务已取消'));}
 async tick(){
  if(this.closed||this.pumping)return;this.pumping=true;
  try{
   if(this.current){
    const row=this.db.prepare('SELECT a.ownerId,q.* FROM ai_jobs a JOIN alarm_ai_jobs q ON q.jobId=a.id WHERE a.id=?').get(this.current.id);
    if(!row||!this.enabled()||!this.authorized(row.ownerId,row.deviceId,row.channelId))this.current.controller.abort(aiProblem(403,'QWEN_SCOPE_REVOKED','自动分析已停用或设备权限已撤销'));
    else{const reason=this.resourceReason(false);if(reason)this.current.controller.abort(aiProblem(429,'QWEN_RESOURCE_BUSY',reason));}
    return;
   }
   this.db.prepare("UPDATE ai_jobs SET status='failed',error='排队超过15分钟，已跳过',finishedAt=? WHERE status='queued' AND id IN(SELECT jobId FROM alarm_ai_jobs WHERE queuedAt<?)").run(new Date(this.now()).toISOString(),new Date(this.now()-900000).toISOString());
   if(!this.enabled()){
    this.db.prepare("UPDATE ai_jobs SET status='cancelled',error='Qwen自动分析已停用',finishedAt=? WHERE status='queued' AND id IN(SELECT jobId FROM alarm_ai_jobs)").run(new Date(this.now()).toISOString());return;
   }
   if(!this.runner.ready())return;
   await this.collect();
   if(this.closed)return;
   this.db.prepare('DELETE FROM alarm_ai_jobs WHERE jobId IS NULL AND queuedAt<?').run(new Date(this.now()-this.ai.settings.state.retentionDays*86400000).toISOString());
   const reason=this.resourceReason();
   if(reason){this.db.prepare("UPDATE ai_jobs SET error=? WHERE status='queued' AND id IN(SELECT jobId FROM alarm_ai_jobs)").run(reason);return;}
   const last=this.db.prepare('SELECT max(startedAt) at FROM alarm_ai_jobs').get().at;
   if(last&&this.now()-Date.parse(last)<60000)return;
   const row=this.db.prepare("SELECT a.*,q.deviceId,q.snapshotId,q.queuedAt FROM ai_jobs a JOIN alarm_ai_jobs q ON q.jobId=a.id WHERE a.status='queued' AND q.nextAttempt<=? ORDER BY q.queuedAt,a.rowid LIMIT 1").get(this.now());if(!row)return;
   if(!this.authorized(row.ownerId,row.deviceId,row.channelId)){
    this.db.prepare("UPDATE ai_jobs SET status='failed',error='分析或设备权限已撤销',image=NULL,finishedAt=? WHERE id=?").run(new Date(this.now()).toISOString(),row.id);return;
   }
   this.db.prepare("UPDATE ai_jobs SET status='running',error=NULL WHERE id=?").run(row.id);
   this.db.prepare('UPDATE alarm_ai_jobs SET startedAt=? WHERE jobId=?').run(new Date(this.now()).toISOString(),row.id);
   const controller=new AbortController(),item={id:row.id,controller,promise:null};this.current=item;
   item.promise=this.work(row,controller).finally(()=>{if(this.current===item)this.current=null;});
  }finally{this.pumping=false;}
 }
 async work(row,controller){
  try{
   const model=this.runner.profile?.model||QWEN_MODEL;
   const reanalysis=JSON.parse(row.usage||'{}').reanalysis===true;
   const previous=!reanalysis&&this.db.prepare("SELECT a.id,a.image,a.result,q.capturedAt FROM ai_jobs a JOIN alarm_ai_jobs q ON q.jobId=a.id WHERE a.ownerId=? AND a.channelId=? AND a.model=? AND a.status='succeeded' AND a.expiresAt>? AND q.capturedAt<=? AND q.capturedAt>=? AND a.image IS NOT NULL AND coalesce(json_extract(a.usage,'$.similarScene'),0)=0 ORDER BY q.capturedAt DESC LIMIT 1").get(row.ownerId,row.channelId,model,new Date(this.now()).toISOString(),row.capturedAt,new Date(Date.parse(row.capturedAt)-120000).toISOString());
   let out;
   try {
    if(previous&&await sameAlarmScene(Buffer.from(row.image),Buffer.from(previous.image))){
     out={result:JSON.parse(previous.result),model,metrics:{cached:true,similarScene:true}};
    }
   }catch{/* Invalid comparison/cache falls back to real analysis. */}
   controller.signal.throwIfAborted();
   out||=await this.runner.run(Buffer.from(row.image),controller.signal);controller.signal.throwIfAborted();
   if(!this.enabled()||!this.authorized(row.ownerId,row.deviceId,row.channelId))throw aiProblem(403,'QWEN_SCOPE_REVOKED','分析已停用或设备权限已撤销');
   this.db.prepare("UPDATE ai_jobs SET status='succeeded',result=?,usage=?,model=?,error=NULL,finishedAt=? WHERE id=? AND status='running'").run(JSON.stringify(out.result),JSON.stringify({local:true,...(reanalysis?{reanalysis:true}:{}),...out.metrics}),out.model||QWEN_MODEL,new Date(this.now()).toISOString(),row.id);
  }catch(e){
   const failure=controller.signal.reason||e,retry=failure.code==='QWEN_RESOURCE_BUSY'&&!this.closed;
   this.db.prepare("UPDATE ai_jobs SET status=?,error=?,finishedAt=?,image=CASE WHEN ? THEN NULL ELSE image END WHERE id=? AND status='running'").run(retry?'queued':this.closed?'interrupted':failure.code==='QWEN_CANCELLED'?'cancelled':'failed',failure.status?failure.message:'本地告警分析失败，请检查模型和图片',retry?null:new Date(this.now()).toISOString(),Number(failure.status===403),row.id);
   if(retry)this.db.prepare('UPDATE alarm_ai_jobs SET nextAttempt=? WHERE jobId=?').run(this.now()+60000,row.id);
  }
 }
 async close(){this.closed=true;clearInterval(this.timer);this.current?.controller.abort(aiProblem(409,'QWEN_CLOSED','平台关闭，自动分析中断'));await this.current?.promise;while(this.pumping)await new Promise(r=>setTimeout(r,10));}
}
