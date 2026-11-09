import {test} from 'node:test';import assert from 'node:assert/strict';import {openStore} from './lib/store.mjs';import {AlarmGuard} from './services/alarm-guard.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('国标布防：200不是业务完成，匹配应答、重复请求、拒绝及关闭回收',async()=>{
 const {db}=openStore(':memory:');db.prepare('INSERT INTO devices(id,deviceId,name,createdAt,status,registeredUntil,remoteAddress,remotePort) VALUES(?,?,?,?,?,?,?,?)').run('d','34020000001320000001','海康','now','online',Date.now()+60000,'127.0.0.1',5060);
 let calls=[];const sip={state:'listening',seq:1,requests:{request:async v=>{calls.push(v);return {status:200}}}},access={can:()=>true,requireDevice:()=>{}};
 const g=new AlarmGuard({db,sip,access,timeout:100});const first=g.start('a','d');assert.equal(g.start('a','d').id,first.id);await delay(5);assert.equal(calls.length,1);assert.match(calls[0].body,/<GuardCmd>SetGuard/);assert.equal(g.latest('d').phase,'protocol_accepted');
 const response={Response:{CmdType:'DeviceControl',SN:'2',DeviceID:'34020000001320000001',Result:'OK'}};assert.equal(g.handle({id:'other'},response),false);assert.equal(g.handle({id:'d',deviceId:'other'},response),false);assert.equal(g.handle({id:'d',deviceId:'34020000001320000001'},response),true);assert.equal(g.latest('d').status,'succeeded');
 g.start('a','d');await delay(130);assert.equal(g.latest('d').status,'failed');assert.match(g.latest('d').error,/业务应答超时/);
 sip.requests.request=async()=>({status:403});g.start('a','d');await delay(5);assert.match(g.latest('d').error,/403/);
 access.can=()=>false;assert.throws(()=>g.start('v','d'),/权限/);access.can=()=>true;g.start('a','d');await g.close();assert.equal(g.pending.size,0);db.close();
});
