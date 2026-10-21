// A standalone read-only verifier, run after validation services have stopped.
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
export function checkData(current:string,previous:string):void {
 const beforePath=path.join(previous,'runtime.sqlite'),afterPath=path.join(current,'runtime.sqlite');
 if(!fs.existsSync(beforePath)){if(!fs.existsSync(afterPath))throw Error('New database missing');return;}
 const before=new DatabaseSync(beforePath,{readOnly:true}),after=new DatabaseSync(afterPath,{readOnly:true});
 try {
  if(Object.values(after.prepare('PRAGMA integrity_check').get()!)[0]!=='ok')throw Error('Database integrity failed');
  for(const table of ['bots','sessions','session_messages','agent_memory','bot_rooms','bot_room_messages','bot_functional_groups','attachments','image_assets','artifacts','projects','project_roots']){
   if(!before.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   const columns=before.prepare(`PRAGMA table_info("${table}")`).all();
   const pk=columns.filter(c=>Number(c.pk)>0).map(c=>String(c.name));
   if(!pk.length)throw Error('Cannot verify identity preservation for '+table);
   for(const row of before.prepare(`SELECT * FROM "${table}"`).all()){
    const preserved=after.prepare(`SELECT * FROM "${table}" WHERE ${pk.map(k=>'"'+k+'" = ?').join(' AND ')}`).get(...pk.map(k=>row[k]));
    if(!preserved)throw Error('Data missing from '+table);
    if(['session_messages','agent_memory','bot_room_messages','project_roots'].includes(table))for(const [key,value] of Object.entries(row))if(!isDeepStrictEqual(value,preserved[key]))throw Error('Preserved content changed in '+table);
   }
  }
  for(const table of ['attachments','image_assets','artifacts'])if(after.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))for(const row of after.prepare(`SELECT local_rel_path FROM "${table}"`).all()){
   if(typeof row.local_rel_path==='string'&&fs.existsSync(path.resolve(previous,row.local_rel_path))&&!fs.existsSync(path.resolve(current,row.local_rel_path)))throw Error('Asset file missing');
  }
 }finally{before.close();after.close();}
}
if(typeof require !== 'undefined' && require.main===module)checkData(process.argv[2]!,process.argv[3]!);
