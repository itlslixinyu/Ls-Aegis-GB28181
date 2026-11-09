// Offline real-model verification. Expectations check output only; they are never
// included in the model prompt. The installation database is opened read-only.
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {QwenRunner} from '../backend/ai/qwen-runner.mjs';

const {values}=parseArgs({options:{image:{type:'string'},repeat:{type:'string',default:'1'},expect:{type:'string'},reject:{type:'string'},report:{type:'string'},database:{type:'string',default:'data/platform.db'}}});
const count=Number(values.repeat);
if(!values.image||!values.report||!Number.isInteger(count)||count<1||count>5)throw Error('Use --image PATH --report PATH [--repeat 1..5] [--expect REGEX] [--reject REGEX]');
const expected=values.expect?new RegExp(values.expect):null,rejected=values.reject?new RegExp(values.reject):null;
const image=await readFile(values.image),runner=new QwenRunner({diagnostics:true});
const db=existsSync(values.database)?new DatabaseSync(values.database,{readOnly:true}):null;
function busy(starting=true){
 if(freemem()<(starting?(runner.profile.startMemoryMiB||3072):1024)*1048576)return 'memory';
 if(!db)return null;
 if(db.prepare("SELECT 1 FROM ai_jobs WHERE status='running' UNION ALL SELECT 1 FROM ai_history_searches WHERE status IN ('queued','running') LIMIT 1").get())return 'platform AI';
 if(db.prepare("SELECT count(*) n FROM recording_jobs WHERE status IN ('starting','recording','finalizing')").get().n>=2||db.prepare('SELECT count(*) n FROM viewers WHERE expiresAt>?').get(Date.now()).n>=4)return 'media load';
 return null;
}
const report={at:new Date().toISOString(),image:values.image,sha256:createHash('sha256').update(image).digest('hex'),model:runner.profile.model,profile:runner.profile,runs:[],passed:false};
try{
 for(let i=0;i<count;i++){
  const deadline=Date.now()+300000;
  while(busy()){if(Date.now()>deadline)throw Error('Resource wait timed out: '+busy());await new Promise(r=>setTimeout(r,1500));}
  const controller=new AbortController(),timer=setInterval(()=>{const reason=busy(false);if(reason)controller.abort(Error('Yielding to '+reason));},1000);
  let result;
  try{result=await runner.run(image,controller.signal);}finally{clearInterval(timer);}
  const content=result.result.summary+' '+result.result.tags.join(' ');
  const passed=(!expected||expected.test(content))&&(!rejected||!rejected.test(content));
  report.runs.push({...result,passed});await writeFile(values.report,JSON.stringify(report,null,2));
  console.log(JSON.stringify({run:i+1,passed,...result.result,metrics:result.metrics}));
  if(!passed)throw Error('Caption did not meet verification expectations');
 }
 report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{db?.close();await writeFile(values.report,JSON.stringify(report,null,2));}
