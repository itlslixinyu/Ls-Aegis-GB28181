// Run with the platform stopped. Preserve the exported snapshot; only alter a new copy.
import {DatabaseSync} from 'node:sqlite';
import {mkdir,copyFile,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const [sourceArg,targetArg='data/development']=process.argv.slice(2);
if(!sourceArg)throw Error('Usage: node scripts/prepare-mac-development.mjs <exported snapshot directory> [new target directory]');
const source=resolve(sourceArg),target=resolve(targetArg);
if(source===target)throw Error('Source and target must differ');
try{await access(target);throw Error('Target exists; choose a new directory. No files were overwritten.');}catch(e){if(e.code!=='ENOENT')throw e;}
const original=new DatabaseSync(join(source,'platform.db'),{readOnly:true});
try{if(original.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Source database integrity check failed');}finally{original.close();}
await mkdir(target,{recursive:true});
for(const name of ['platform.db','ai-master.key','ai-config.json'])await copyFile(join(source,name),join(target,name));
const db=new DatabaseSync(join(target,'platform.db'));
const now=new Date().toISOString(),note='Mac development copy: previous runtime stopped; explicit reactivation required';
try{
 db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
 db.exec('UPDATE recording_plans SET enabled=0; UPDATE cascade_platforms SET enabled=0; DELETE FROM sessions; DELETE FROM viewers;');
 db.prepare("UPDATE recording_jobs SET status='cancelled',error=?,finishedAt=? WHERE status IN ('queued','starting','recording','finalizing')").run(note,now);
 db.exec("UPDATE live_sessions SET state='closed',released=1,dialog=NULL");
 db.prepare("UPDATE ai_jobs SET status='cancelled',error=?,finishedAt=? WHERE status IN ('queued','running')").run(note,now);
 db.prepare("UPDATE ai_history_searches SET status='cancelled',phase='finished',error=?,finishedAt=? WHERE status IN ('queued','running')").run(note,now);
 db.exec('COMMIT');
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Development database check failed');
}finally{db.close();}
const ai=JSON.parse(await readFile(join(target,'ai-config.json'),'utf8'));
Object.assign(ai,{enabled:false,indexEnabled:false,qwenAlarmEnabled:false});
await writeFile(join(target,'ai-config.json'),JSON.stringify(ai,null,2));
const settings=JSON.parse(await readFile(join(source,'access-config.json'),'utf8'));
Object.assign(settings.values.sip,{enabled:false,host:'127.0.0.1',advertisedHost:'127.0.0.1'});
Object.assign(settings.values.media,{url:'',playUrl:'',rtpHost:'127.0.0.1',secret:'',hookToken:''});
settings.revision=randomUUID();
await writeFile(join(target,'access-config.json'),JSON.stringify(settings,null,2));
console.log(JSON.stringify({target,integrity:'ok',sourceUnchanged:true,realDeviceAccess:false,automaticTasks:false}));
