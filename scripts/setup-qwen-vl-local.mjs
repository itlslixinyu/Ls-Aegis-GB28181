import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';import {Transform,Readable} from 'node:stream';import {createHash} from 'node:crypto';import {setTimeout as wait} from 'node:timers/promises';
const revision='52d6c8ffea26cc873ac5ad116f8631268d7eb503';
const modelRoot='data/ai-models/qwen3-vl-2b-q4';const runtimeRoot='data/ai-tools/llama-b12189';
const files=[
 {path:runtimeRoot+'/runtime.zip',url:'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-win-cpu-x64.zip',bytes:24749596,sha256:'f912ea5e3e397c63405c81e732131ab0fa6e72411c80546bb5ad643f7dd82aac'},
 {path:modelRoot+'/Qwen3VL-2B-Instruct-Q4_K_M.gguf',url:`https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/${revision}/Qwen3VL-2B-Instruct-Q4_K_M.gguf`,bytes:1107409952,sha256:'089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae'},
 {path:modelRoot+'/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',url:`https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/${revision}/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf`,bytes:445053216,sha256:'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82'}];
await mkdir(modelRoot,{recursive:true});await mkdir(runtimeRoot,{recursive:true});
for(const f of files){if(existsSync(f.path)){const h=createHash('sha256');for await(const b of createReadStream(f.path))h.update(b);if(h.digest('hex')===f.sha256){console.log('verified',f.path);continue;}}
 const response=await fetch(f.url,{signal:AbortSignal.timeout(1200000)});if(!response.ok)throw Error('Download HTTP '+response.status);let size=0,last=0;const hash=createHash('sha256'),start=Date.now();
 const meter=new Transform({transform(chunk,_,cb){size+=chunk.length;hash.update(chunk);if(size-last>=64*1024*1024){console.log(f.path,Math.round(size/1048576)+' MiB');last=size;}const delay=Math.max(0,size/(8*1024*1024)*1000-(Date.now()-start));if(delay>3)wait(delay).then(()=>cb(null,chunk));else cb(null,chunk);}});
 await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(f.path+'.part'));
 if(size!==f.bytes||hash.digest('hex')!==f.sha256)throw Error('Model size/hash mismatch');await rename(f.path+'.part',f.path);console.log('downloaded and verified',f.path,size);
}
await writeFile(modelRoot+'/manifest.json',JSON.stringify({model:'Qwen/Qwen3-VL-2B-Instruct-GGUF',revision,quantization:'Q4_K_M',visionQuantization:'Q8_0',license:'Apache-2.0',runtime:'llama.cpp b12189 CPU x64',files,scope:'isolated-caption-benchmark-only'},null,2));
