import {spawn} from 'node:child_process';
import {setPriority,constants,freemem} from 'node:os';
import {tmpdir} from 'node:os';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative,basename} from 'node:path';
import sharp from 'sharp';
import {aiProblem} from './settings.mjs';
const baselinePrompt='请只根据图片可见内容，用简体中文输出两行：描述：一句简短客观的画面描述（不超过60字，包括人数、主要物体、衣服颜色、位置或姿态）；标签：3至6个搜索关键词，用逗号分隔。不要把水印、时间戳和摄像机名称当作场景内容。不推测身份、职业、情绪、意图；单张图片不能证明运动过程。看不清的细节不要编造。';
const releasedInventoryProfile={size:640,imageTokens:512,minImageTokens:256,context:2048,ubatch:64,startMemoryMiB:3584,outputTokens:224,prompt:'列出图片中主要可见的物体，最多5项。输出JSON，items每项包含name物体名称、color可辨认的颜色（不清楚填空字符串）、position画面位置。忽略水印文字，只写静态可见物体，不推测动作和身份。',groundTags:true,inventory:true};
const inventoryPrompt='观察图片，只列出最显著且可直接辨认的1至3类实体，优先可见的人体或交通工具，不必凑数。可见人体统一称人物，人物颜色只指衣物颜色，不推测性别。类别看不清时只写可见外观，不猜具体设备、零件或用途。不描述动作、身份、天气，不抄图片文字。输出JSON：items每项含name实体或外观、color颜色、position画面位置；颜色和位置看不清可填空字符串。';
const inventoryProfile={size:640,imageTokens:512,minImageTokens:256,context:2048,ubatch:64,startMemoryMiB:3584,outputTokens:192,maxItems:3,prompt:inventoryPrompt,systemPrompt:'Describe only directly visible physical scene content. Name an object only when its shape is clear; otherwise describe its appearance without guessing its identity or function. Printed text, timestamps and watermarks are not scene objects.',groundTags:true,inventory:true};
export const QWEN_PROFILES=Object.freeze({
 baseline:Object.freeze({size:448,imageTokens:256,outputTokens:160,prompt:baselinePrompt,model:'local-qwen3-vl-2b-q4-k-m:q8-vision:448:v1'}),
 optimized:Object.freeze({...releasedInventoryProfile,model:'local-qwen3-vl-2b-q4-k-m:q8-vision:640:p6i1'}),
 threads2:Object.freeze({...releasedInventoryProfile,threads:2,cpuMask:'0x500',model:'local-qwen3-vl-2b-q4-k-m:q8-vision:640:p6i1:t2'}),
 threads4:Object.freeze({...releasedInventoryProfile,threads:4,cpuMask:'0x550',model:'local-qwen3-vl-2b-q4-k-m:q8-vision:640:p6i1:t4'}),
 candidate:Object.freeze({...inventoryProfile,grounded:true,threads:2,cpuMask:'0x500',model:'local-qwen3-vl-2b-q4-k-m:q8-vision:640:p9i2:t2'}),
});
export const QWEN_DEFAULT_PROFILE='threads2';
export const QWEN_MODEL=QWEN_PROFILES[QWEN_DEFAULT_PROFILE].model;
const wordSegmenter=new Intl.Segmenter('zh',{granularity:'word'});
const inventorySchema={type:'object',properties:{items:{type:'array',minItems:1,maxItems:5,items:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:16},color:{type:'string',maxLength:16},position:{type:'string',maxLength:24}},required:['name','color','position'],additionalProperties:false}}},required:['items'],additionalProperties:false};
const assessmentSchema={type:'object',properties:{scene:{type:'string',enum:['wide','closeup','unclear']},personVisible:{type:'boolean'},vehicleVisible:{type:'boolean'},identityClear:{type:'boolean'},appearance:{type:'string',minLength:5,maxLength:80}},required:['scene','personVisible','vehicleVisible','identityClear','appearance'],additionalProperties:false};
const assessmentPrompt='先判断图像能可靠看清什么。输出JSON：scene为wide远景、closeup近距离局部或unclear；personVisible表示有可直接辨认的人体；vehicleVisible表示有可辨认的整车轮廓（仅亮斑或局部灯光不算）；identityClear表示主要物体的整体形状足够清楚，能确认类别。appearance用简短中文描述主要形状、颜色及分布，不能猜设备名或用途，不读时间戳及水印。';
export function normalizeQwenAssessment(raw){
 let value;try{value=JSON.parse(String(raw).trim());}catch{throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型未返回完整画面可辨识评估');}
 if(!value||!['wide','closeup','unclear'].includes(value.scene)||['personVisible','vehicleVisible','identityClear'].some(k=>typeof value[k]!=='boolean')||typeof value.appearance!=='string'||value.appearance.length<5||value.appearance.length>80||/[\r\n]/.test(value.appearance))throw aiProblem(502,'QWEN_INVALID_RESULT','画面可辨识评估无效');
 return value;
}
export async function opticalQuality(image){
 const {data,info}=await sharp(image,{limitInputPixels:16000000}).removeAlpha().toColourspace('srgb').resize({width:256,height:256,fit:'inside',withoutEnlargement:true}).raw().toBuffer({resolveWithObject:true});
 const luma=[];let chroma=0,clipped=0,dark=0,highlightX=0,highlightY=0;
 for(let i=0;i<data.length;i+=info.channels){
  const r=data[i],g=data[i+1],b=data[i+2],high=Math.max(r,g,b),low=Math.min(r,g,b),y=.299*r+.587*g+.114*b,p=luma.length;
  luma.push(y);if(high-low>20&&high>40)chroma++;if(y<=80)dark++;
  if(y>=245){clipped++;highlightX+=p%info.width;highlightY+=Math.floor(p/info.width);}
 }
 let edge=0,n=0;
 for(let y=1;y<info.height-1;y++)for(let x=1;x<info.width-1;x++){const i=y*info.width+x;edge+=Math.abs(4*luma[i]-luma[i-1]-luma[i+1]-luma[i-info.width]-luma[i+info.width]);n++;}
 const hx=clipped?highlightX/clipped/info.width:.5,hy=clipped?highlightY/clipped/info.height:.5;
 const horizontal=hx<1/3?'左':hx>2/3?'右':'',vertical=hy<1/3?'上':hy>2/3?'下':'';
 return {chromaFraction:chroma/luma.length,clippedFraction:clipped/luma.length,darkFraction:dark/luma.length,detailScore:edge/Math.max(n,1),highlightPosition:'画面'+(horizontal||vertical?horizontal+vertical+'部':'中部')};
}
export function unresolvedGlare(facts,quality){
 return facts.scene==='closeup'&&!facts.personVisible&&quality.chromaFraction<.01&&quality.clippedFraction>=.03&&quality.darkFraction>=.35&&quality.detailScore<8;
}
export function uncertainQwenCaption(assessment){
 if(assessment.identityClear||assessment.personVisible||assessment.vehicleVisible)throw aiProblem(502,'QWEN_INVALID_RESULT','不可将可辨认主体替换为不确定结果');
 if(overlayValue.test(assessment.appearance)||/时间戳|水印|车灯|灯罩|摄像头|手机|机器人/.test(assessment.appearance))throw aiProblem(502,'QWEN_INVALID_RESULT','不确定画面仍含未经确认的具体类别或画面文字');
 const summary='可见：'+assessment.appearance.replace(/[。；;]+$/,'')+'；主体类型不明。';
 const words=['白色','黑色','灰色','高亮','反光','亮斑','光斑','模糊','圆形','矩形','轮廓'].filter(word=>summary.includes(word));
 return {summary,tags:[...new Set([...words,'主体类型不明'])],objects:[],observations:[]};
}
const overlayName=/^(?:时间戳|水印|日期|时间|日期文字|时间文字|画面时间|录像时间|视频时间|摄像机名称|设备编号|文字|文本|页面文字|画面文字)$/;
const overlayValue=/\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|星期[一二三四五六日天]/;
export function normalizeQwenInventory(raw){
 let value;try{value=JSON.parse(String(raw).trim());}catch{throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型未返回完整物体描述');}
 if(!value||!Array.isArray(value.items)||!value.items.length||value.items.length>5)throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型物体描述格式无效');
 const items=[],seen=new Set();
 for(const item of value.items){
  if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.length>16||typeof item.color!=='string'||item.color.length>16||typeof item.position!=='string'||item.position.length>24||/[\r\n]/.test(item.name+item.color+item.position))throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型物体字段无效');
  const clean={name:item.name.trim(),color:item.color.trim(),position:item.position.trim()};
  if(overlayName.test(clean.name)||overlayValue.test(clean.name))continue;
  if(overlayValue.test(clean.color))clean.color='';
  if(overlayValue.test(clean.position))clean.position='';
  const key=JSON.stringify(clean);
  if(!seen.has(key)){seen.add(key);items.push(clean);}
 }
 if(!items.length)throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型只返回了画面文字，未提供可见实体');
 const summary='可见：'+items.map(item=>item.name+([item.color,item.position].some(Boolean)?'（'+[item.color,item.position].filter(Boolean).join('，')+'）':'')).join('；')+'。';
 const tags=[...new Set(items.flatMap(item=>[item.name,item.color]).filter(Boolean))];
 return normalizeQwenCaption('描述：'+summary+'\n标签：'+tags.join('，'),{groundTags:true,structured:true});
}
export function normalizeQwenCaption(raw,{groundTags=false,structured=false}={}){
 const lines=String(raw).replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).map(s=>s.trim().replace(/^\d+[.、]\s*/, '')).filter(Boolean);
 const subjective=/思考|惊讶|开心|悲伤|愤怒|焦虑|紧张|害怕|职业|意图|目的|身份/;
 const description=(lines[0]||'').replace(/^(描述|画面描述)[:：]\s*/,'');
 const clauses=description.split(/[，,。；;！!]/).map(s=>s.trim()).filter(Boolean);
 const repeated=!structured&&clauses.some((s,i)=>s.length>=4&&clauses.indexOf(s)!==i);
 const echo=/颜色、位置、朝向或姿态|未见模糊遮挡|输出两行|严格输出|从上述描述中|不为满足要求|数量[（(]仅清楚可数时/.test(description);
 const contradictory=['车辆','汽车','人员','人物'].some(noun=>{
  const negative=new RegExp('(?:未见|没有|无)(?:明显|明确|清晰|可见)?[^，,。；;]{0,8}'+noun);
  const positive=new RegExp('(?:有|多辆|几辆|一辆|两辆|数辆|一名|两名|多人|多名)[^，,。；;]{0,6}'+noun);
  return negative.test(description)&&positive.test(description.replace(new RegExp('没有[^，,。；;]*','g'),''));
 });
 if(repeated||echo||contradictory)throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型描述重复、复述指令或存在矛盾，识别结果不可靠');
 let summary=(lines[0]||'').replace(/^(描述|画面描述)[:：]\s*/,'').replace(/海康测试摄像机/g,'').split(/[，；]/).filter(part=>!subjective.test(part)).join('，').slice(0,600).trim();
 if(!/[\u3400-\u9fff]/.test(summary)||summary.length<5)throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型未返回有效中文描述');
 const labels=lines.slice(1).join('，').replace(/^(标签|关键词)[:：]\s*/,'');
 if(groundTags){
  const labelWords=labels.split(/[,，、;；|]/).map(s=>s.trim()).filter(Boolean);
  if(!/^(描述|画面描述)[:：]/.test(lines[0]||'')||!lines.slice(1).some(s=>/^(标签|关键词)[:：]/.test(s))||labelWords.some(s=>labelWords.filter(x=>x===s).length>=3))
   throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型未按格式输出或标签反复重复，识别结果不可靠');
 }
 const instructionNoise=/\d+\s*(?:至|到|[-~～])\s*\d+\s*个(?:具体)?(?:搜索)?(?:关键词|名词|标签)|输出两行|不超过\d+字/;
 const tags=[...new Set(labels.split(/[,，、;；|]/).map(t=>t.trim().replace(/[。.!！]+$/,'')).filter(t=>t&&t.length<=32&&!/海康|摄像机|时间戳|不确定|未见|没有|看不清|无法确认/.test(t)&&!subjective.test(t)&&!instructionNoise.test(t)))].filter(t=>{
  if(!groundTags)return true;
  // Require each tag word to occur in the description. This is a conservative
  // consistency check, not a visual truth check or a replacement object label.
  const words=[...wordSegmenter.segment(t)].filter(x=>x.isWordLike);
  return words.length>0&&words.every(x=>summary.includes(x.segment));
 }).slice(0,12);
 if(groundTags&&!tags.length)throw aiProblem(502,'QWEN_INVALID_RESULT','本地模型未提供有效检索标签，识别结果不可靠');
 return {summary,tags,objects:[],observations:[]};
}
export class QwenRunner {
 constructor({root=process.cwd(),profile=QWEN_DEFAULT_PROFILE,diagnostics=false}={}){
  if(!Object.hasOwn(QWEN_PROFILES,profile))throw Error('Unknown Qwen profile');
  this.profile=QWEN_PROFILES[profile];
  this.diagnostics=diagnostics===true;
  this.exe=resolve(root,'data/ai-tools/llama-b12189/bin/llama-mtmd-cli.exe');
  this.model=resolve(root,'data/ai-models/qwen3-vl-2b-q4/Qwen3VL-2B-Instruct-Q4_K_M.gguf');
  this.vision=resolve(root,'data/ai-models/qwen3-vl-2b-q4/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf');
 }
 ready(){return process.platform==='win32'&&[this.exe,this.model,this.vision].every(existsSync);}
 async run(image,signal,question=''){
  if(!this.profile.grounded)return this.runPass(image,signal,question);
  const deadline=new AbortController();
  const timer=setTimeout(()=>deadline.abort(aiProblem(504,'QWEN_TIMEOUT','本地分析超时')),120000);
  try{return await this.runGrounded(image,AbortSignal.any([signal,deadline.signal]),question);}
  finally{clearTimeout(timer);}
 }
 async runGrounded(image,signal,question=''){
  const started=performance.now();
  const assessment=await this.runPass(image,signal,'',{...this.profile,inventory:false,assessment:true,outputTokens:192,prompt:assessmentPrompt,systemPrompt:'Assess only visible shapes and observability. Do not infer a whole object from isolated glare or a small component. Ignore all printed overlays. Return JSON only.'});
  signal.throwIfAborted();
  const facts=assessment.result;
  const quality=await opticalQuality(image);
  signal.throwIfAborted();
  if(unresolvedGlare(facts,quality)){
   const result={summary:quality.highlightPosition+'有白色高亮区域，画面明暗反差大、细节模糊；主体类型不明。',tags:['白色','高亮区域','细节模糊','主体类型不明'],objects:[],observations:[]};
   return {result,model:this.profile.model,metrics:{...assessment.metrics,elapsedMs:Math.round(performance.now()-started),passes:1,uncertain:true,qualityLimited:true},...(this.diagnostics?{diagnostics:{rawOutput:assessment.diagnostics.rawOutput,assessment:facts,opticalQuality:quality,stages:{assessment:assessment.diagnostics}}}:{})};
  }
  if(!facts.identityClear&&!facts.personVisible&&!facts.vehicleVisible){
   let result;
   try{result=uncertainQwenCaption(facts);}catch(error){if(this.diagnostics)Object.assign(error,{diagnostics:{rawOutput:assessment.diagnostics.rawOutput,assessment:facts},metrics:assessment.metrics});throw error;}
   return {result,model:this.profile.model,metrics:{...assessment.metrics,elapsedMs:Math.round(performance.now()-started),passes:1,uncertain:true},...(this.diagnostics?{diagnostics:{rawOutput:assessment.diagnostics.rawOutput,assessment:facts,stages:{assessment:assessment.diagnostics}}}:{})};
  }
  const caption=await this.runPass(image,signal,question,{...this.profile,prompt:this.profile.prompt+'\n本张图像的独立可见性评估（仅限当前图片，不补充看不见的物体）：'+JSON.stringify(facts)});
  const metrics={elapsedMs:Math.round(performance.now()-started),passes:2,assessmentElapsedMs:assessment.metrics.elapsedMs,captionElapsedMs:caption.metrics.elapsedMs,peakWorkingSetMiB:Math.max(assessment.metrics.peakWorkingSetMiB,caption.metrics.peakWorkingSetMiB),privateMiB:Math.max(assessment.metrics.privateMiB,caption.metrics.privateMiB),cpuSeconds:assessment.metrics.cpuSeconds+caption.metrics.cpuSeconds};
  return {result:caption.result,model:this.profile.model,metrics,...(this.diagnostics?{diagnostics:{rawOutput:caption.diagnostics.rawOutput,assessment:facts,stages:{assessment:assessment.diagnostics,caption:caption.diagnostics}}}:{})};
 }
 async runPass(image,signal,question='',profile=this.profile){
  if(!this.ready())throw aiProblem(503,'QWEN_NOT_READY','本地Qwen模型或运行库未就绪');
  signal.throwIfAborted();
  const directory=await mkdtemp(join(tmpdir(),'ls-qwen-'));let child,watcher;
  try{
   const file=join(directory,'image.jpg'),instruction=join(directory,'prompt.txt');
   await sharp(image,{limitInputPixels:16000000}).resize({width:profile.size,height:profile.size,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toFile(file);
   const focus=String(question||'').trim().slice(0,1000);
   await writeFile(instruction,profile.prompt+(focus?'\n关注要求（仅用于选择图中可见内容，不得据此编造目标；仍遵守上述输出格式）：'+JSON.stringify(focus):''));signal.throwIfAborted();
   const started=performance.now();
   const args=['-m',this.model,'--mmproj',this.vision,'--image',file,'-f',instruction,'-t',String(profile.threads||1),'-tb',String(profile.threads||1),'--cpu-mask',profile.cpuMask||'0x400','--cpu-strict','1','--prio','-1','--poll','0','-ngl','0','--no-mmproj-offload','-c',String(profile.context||1024),'-n',String(profile.outputTokens),'-b','256','-ub',String(profile.ubatch||64),'--image-min-tokens',String(profile.minImageTokens||64),'--image-max-tokens',String(profile.imageTokens),'--temp','0','--seed','2026','--no-warmup'];
   if(profile.inventory){
    const schema={...inventorySchema,properties:{items:{...inventorySchema.properties.items,maxItems:profile.maxItems||5}}};
    args.push('--json-schema',JSON.stringify(schema),'--repeat-penalty','1.1','--repeat-last-n','128');
   }
   if(profile.assessment)args.push('--json-schema',JSON.stringify(assessmentSchema),'--repeat-penalty','1.1','--repeat-last-n','128');
   if(profile.systemPrompt)args.push('--system-prompt',profile.systemPrompt);
   child=spawn(this.exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
   const stats={peakWorkingSetMiB:0,privateMiB:0,cpuSeconds:0};let diagnosticStderr="";
   const output=await new Promise((resolveResult,reject)=>{
    let failure=null,text='',stderrBytes=0,done=false,watchBuffer='';
    const stop=e=>{failure||=e;child.kill();};
    const abort=()=>stop(signal.reason||aiProblem(409,'QWEN_CANCELLED','本地分析已取消'));
    const timer=setTimeout(()=>stop(aiProblem(504,'QWEN_TIMEOUT','本地分析超时')),120000);
    const memory=setInterval(()=>{if(freemem()<1024*1048576)stop(aiProblem(429,'QWEN_RESOURCE_BUSY','可用内存不足，等待资源'));},800);
    child.once('spawn',()=>{
     try{setPriority(child.pid,constants.priority.PRIORITY_BELOW_NORMAL);}catch{stop(aiProblem(503,'QWEN_PRIORITY','无法设置模型低优先级，已停止分析'));return;}
     // Read-only process counters; do not alter PowerShell execution policy.
     const monitor=`while ($true) { $p=Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if (-not $p) { break }; @{peakWorkingSetMiB=([long]$p.PeakWorkingSet64/1MB);privateMiB=([long]$p.PrivateMemorySize64/1MB);cpuSeconds=$p.TotalProcessorTime.TotalSeconds}|ConvertTo-Json -Compress; Start-Sleep -Milliseconds 800 }`;
     watcher=spawn('powershell.exe',['-NoProfile','-Command',monitor],{windowsHide:true,stdio:['ignore','pipe','ignore']});
     watcher.stdout.on('data',chunk=>{watchBuffer+=chunk.toString();const lines=watchBuffer.split(/\r?\n/);watchBuffer=lines.pop();for(const line of lines)try{const s=JSON.parse(line);stats.peakWorkingSetMiB=Math.max(stats.peakWorkingSetMiB,s.peakWorkingSetMiB);stats.privateMiB=Math.max(stats.privateMiB,s.privateMiB);stats.cpuSeconds=Math.max(stats.cpuSeconds,s.cpuSeconds);if(stats.peakWorkingSetMiB>2800)stop(aiProblem(429,'QWEN_RESOURCE_BUSY','模型内存达到保护上限，等待资源'));}catch{}});
     watcher.once('error',()=>stop(aiProblem(503,'QWEN_MONITOR','无法启动模型资源保护')));
     watcher.once('close',()=>{if(!done&&child.exitCode===null&&!child.signalCode)stop(aiProblem(503,'QWEN_MONITOR','模型资源监测中断'));});
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>65536)stop(aiProblem(502,'QWEN_OUTPUT_LIMIT','模型输出超过限制'));});
    child.stderr.on('data',chunk=>{if(this.diagnostics&&diagnosticStderr.length<65536)diagnosticStderr+=chunk.toString();stderrBytes+=chunk.length;if(stderrBytes>256*1024)stop(aiProblem(502,'QWEN_OUTPUT_LIMIT','模型日志超过限制'));});
    child.once('error',()=>{failure=aiProblem(503,'QWEN_START_FAILED','本地模型进程无法启动');});
    child.once('close',code=>{done=true;clearTimeout(timer);clearInterval(memory);signal.removeEventListener('abort',abort);watcher?.kill();failure?reject(failure):code===0?resolveResult(text):reject(aiProblem(502,'QWEN_FAILED','本地模型运行失败'));});
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   });
   const metrics={...stats,elapsedMs:Math.round(performance.now()-started)};
   let result;
   try{result=profile.assessment?normalizeQwenAssessment(output):profile.inventory?normalizeQwenInventory(output):normalizeQwenCaption(output,{groundTags:profile.groundTags===true});}
   catch(error){if(this.diagnostics)Object.assign(error,{diagnostics:{rawOutput:output,stderr:diagnosticStderr},metrics});throw error;}
   return {result,model:profile.model,metrics,...(this.diagnostics?{diagnostics:{rawOutput:output,stderr:diagnosticStderr}}:{})};
  }finally{watcher?.kill();if(child&&child.exitCode===null&&!child.signalCode)child.kill();const rel=relative(tmpdir(),directory);if(rel&&!rel.startsWith('..')&&basename(directory).startsWith('ls-qwen-'))await rm(directory,{recursive:true,force:true});}
 }
}
