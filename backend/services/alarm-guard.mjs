import { randomUUID } from 'node:crypto';
import { xmlEscape } from '../sip/requests.mjs';
export class AlarmGuard {
  constructor({db,sip,access,timeout=12000}) { Object.assign(this,{db,sip,access,timeout});this.pending=new Map();this.closed=false;
    db.prepare("UPDATE tasks SET status='failed',error='服务重启，布防结果未知' WHERE type='alarm-guard' AND status='running'").run();
  }
  latest(deviceId) {const row=this.db.prepare("SELECT id,status,error,createdAt FROM tasks WHERE deviceId=? AND type='alarm-guard' ORDER BY createdAt DESC,rowid DESC LIMIT 1").get(deviceId);if(!row)return null;const item=[...this.pending.values()].find(x=>x.id===row.id);return {...row,phase:item?.protocolAccepted?'protocol_accepted':row.status};}
  start(userId,deviceId) {
    if(!this.access.can(userId,'subscriptions.manage'))throw Error('没有订阅维护权限');this.access.requireDevice(userId,deviceId);
    if(this.closed)throw Error('服务正在关闭');
    const d=this.db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    if(!d || d.status!=='online' || d.registeredUntil<=Date.now() || this.sip.state!=='listening')throw Error('设备或SIP未在线');
    const old=[...this.pending.values()].find(x=>x.deviceId===deviceId);if(old)return this.latest(deviceId);
    if(this.pending.size>=8)throw Error('布防请求过多，请稍候');
    const id=randomUUID(),sn=String(++this.sip.seq),controller=new AbortController(),item={id,sn,deviceId,controller,protocolAccepted:false};
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id,deviceId,'alarm-guard','running',new Date().toISOString(),null);
    const key=deviceId+':'+sn;this.pending.set(key,item);
    item.finish=(status,error=null)=>{if(!this.pending.has(key))return;clearTimeout(item.timer);this.pending.delete(key);this.db.prepare('UPDATE tasks SET status=?,error=? WHERE id=?').run(status,error,id);controller.abort();};
    item.timer=setTimeout(()=>item.finish('failed',item.protocolAccepted?'SIP已接受，但布防业务应答超时，结果未知':'布防请求超时，结果未知'),this.timeout);item.timer.unref();
    item.promise=this.sip.requests.request({remote:d,uri:`sip:${d.deviceId}@${d.remoteAddress}:${d.remotePort}`,body:`<?xml version="1.0" encoding="UTF-8"?><Control><CmdType>DeviceControl</CmdType><SN>${sn}</SN><DeviceID>${xmlEscape(d.deviceId)}</DeviceID><GuardCmd>SetGuard</GuardCmd></Control>`,signal:controller.signal})
      .then(r=>{if(r.status<200||r.status>=300)item.finish('failed','设备拒绝布防：'+r.status);else item.protocolAccepted=true;})
      .catch(()=>{if(this.pending.has(key))item.finish('failed','布防信令失败，结果未知');});
    return this.latest(deviceId);
  }
  handle(device,xml) {const r=xml.Response;if(r?.CmdType!=='DeviceControl')return false;const item=this.pending.get(device.id+':'+String(r.SN));if(!item||r.DeviceID!==device.deviceId)return false;
    item.finish(r.Result==='OK'?'succeeded':'failed',r.Result==='OK'?null:'设备返回布防失败或无效应答');return true;
  }
  async close(){this.closed=true;const jobs=[...this.pending.values()];for(const x of jobs)x.finish('failed','服务关闭，布防结果未知');await Promise.allSettled(jobs.map(x=>x.promise));}
}
