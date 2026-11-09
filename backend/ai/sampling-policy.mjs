import {cosine} from './local-model.mjs';

export const SAMPLING_POLICY_VERSION='adaptive-coarse-v1';
export function samplingPolicy(from,to){
 const start=Date.parse(from),stop=Date.parse(to),seconds=(stop-start)/1000;
 return {start,stop,seconds,interval:seconds<=900?10:seconds<=3600?30:seconds<=21600?120:300,coarse:seconds>900};
}
export function periodicPlan(policy,file,begin,end){
 if(end<=begin)return [];
 if(!policy.coarse){
  const times=[];for(let at=begin;at<end;at+=10)times.push(at);
  if(end-begin>2)times.push(end-1);return [...new Set(times)];
 }
 const first=file.timestamp+begin*1000,last=file.timestamp+end*1000,step=policy.interval*1000;
 const times=[];
 for(let at=policy.start+Math.ceil((first-policy.start)/step)*step;at<last;at+=step)times.push((at-file.timestamp)/1000);
 // Endpoints belong to the query, not to every recorder file.
 if(first<=policy.start&&policy.start<last)times.push((policy.start-file.timestamp)/1000);
 if(first<=policy.stop-1000&&policy.stop-1000<last)times.push((policy.stop-1000-file.timestamp)/1000);
 return [...new Set(times)].sort((a,b)=>a-b);
}
export function coarseMotionWindows(policy,file,begin,end){
 const windows=[];
 for(let i=0;i<8;i++){
  const center=policy.start+policy.seconds*1000*(i+.5)/8;
  const from=Math.max(begin,(center-15000-file.timestamp)/1000);
  const to=Math.min(end,(center+15000-file.timestamp)/1000);
  if(to-from>=1)windows.push([from,to]);
 }
 return windows;
}
// These are similar candidate intervals, not proof that a target stayed visible.
export function groupCandidateFrames(frames,{gapSeconds=15,similarity=.985}={}){
 const groups=[];
 for(const frame of [...frames].sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt))){
  const time=Date.parse(frame.capturedAt);
  const previous=groups.findLast(g=>g.channelId===frame.file.channelId);
  if(previous&&time-previous.lastTime<=gapSeconds*1000&&cosine(previous.last.embedding,frame.embedding)>=similarity){
   previous.last=frame;previous.lastTime=time;previous.count++;
   if(frame.rankScore>previous.best.rankScore)previous.best=frame;
  }else groups.push({channelId:frame.file.channelId,firstTime:time,lastTime:time,last:frame,best:frame,count:1});
 }
 return groups.map(g=>({...g.best,segment:{from:new Date(g.firstTime).toISOString(),to:new Date(g.lastTime).toISOString(),sampleCount:g.count}})).sort((a,b)=>b.rankScore-a.rankScore);
}
