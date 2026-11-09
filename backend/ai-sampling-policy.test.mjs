import {test} from 'node:test';
import assert from 'node:assert/strict';
import {samplingPolicy,periodicPlan,coarseMotionWindows,groupCandidateFrames} from './ai/sampling-policy.mjs';
const start=Date.parse('2026-11-08T00:00:00+08:00');
test('长查询按全局时间轴取样，不因录像切成96个文件重复补尾帧',()=>{
 const policy=samplingPolicy(new Date(start).toISOString(),new Date(start+86400000).toISOString());
 const full=periodicPlan(policy,{timestamp:start},0,86400).map(x=>start+x*1000);
 const split=[];let motionSeconds=0;
 for(let i=0;i<96;i++){
  const file={timestamp:start+i*900000};
  split.push(...periodicPlan(policy,file,0,900).map(x=>file.timestamp+x*1000));
  motionSeconds+=coarseMotionWindows(policy,file,0,900).reduce((n,[a,b])=>n+b-a,0);
 }
 assert.deepEqual(split,full);assert.equal(full.length,289);assert.equal(policy.interval,300);
 assert.equal(motionSeconds,240);assert.ok(full.length<8640*.04);
});
test('短查询保留10秒粒度，分钟小时全天切换不越界',()=>{
 for(const [seconds,interval] of [[60,10],[900,10],[3600,30],[21600,120],[86400,300]]){
  const p=samplingPolicy(new Date(start).toISOString(),new Date(start+seconds*1000).toISOString());
  assert.equal(p.interval,interval);assert.ok(periodicPlan(p,{timestamp:start},0,seconds).every(x=>x>=0&&x<seconds));
 }
});
test('相近候选合并时间段，不跨通道或跨长空档合并',()=>{
 const frame=(at,channel='c',rank=.8,embedding=[1,0])=>({capturedAt:new Date(start+at*1000).toISOString(),file:{channelId:channel},embedding,rankScore:rank});
 const groups=groupCandidateFrames([frame(0),frame(10,'c',.9),frame(20),frame(21,'other'),frame(100),frame(105,'c',.8,[0,1])]);
 assert.equal(groups.length,4);const merged=groups.find(x=>x.segment.sampleCount===3);
 assert.equal(merged.rankScore,.9);assert.equal(merged.capturedAt,new Date(start+10000).toISOString());
 assert.equal(merged.segment.from,new Date(start).toISOString());assert.equal(merged.segment.to,new Date(start+20000).toISOString());
});
