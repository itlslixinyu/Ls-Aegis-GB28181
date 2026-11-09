import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Repair only legacy index queues created before fractional-tail completion.
// Original recording files, jobs, plans, permissions and images are untouched.
export function repairIndexTails(db,now=Date.now()){
 return db.prepare(`UPDATE ai_index_files SET nextOffset=duration,state='ready',pendingOffsets='[]',scanEnd=duration,retryAt=0,updatedAt=?
 WHERE state IN ('pending','error') AND nextOffset>0 AND duration-nextOffset>=0 AND duration-nextOffset<1
 AND EXISTS(SELECT 1 FROM ai_index_frames f WHERE f.fileId=ai_index_files.fileId)
 AND NOT EXISTS(SELECT 1 FROM json_each(pendingOffsets) WHERE CAST(value AS REAL)<nextOffset)`).run(now).changes;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const db=new DatabaseSync(resolve(process.argv[2]||'data/platform.db'));
 try{db.exec('PRAGMA busy_timeout=3000');console.log(JSON.stringify({repairedIndexFiles:repairIndexTails(db)}));}finally{db.close();}
}
