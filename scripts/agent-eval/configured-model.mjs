import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';

export async function configuredModel(settingsRoot,botId,driverRoot) {
 const root=resolve(settingsRoot);
 const env={...(existsSync(join(root,'.env'))?parse(readFileSync(join(root,'.env'))):{}),...process.env};
 const db=new DatabaseSync(resolve(root,env.RAW_AGENT_STATE_DIR??'.agent-state','runtime.sqlite'),{readOnly:true});
 try {
  const bot=db.prepare('SELECT canonical_session_id FROM bots WHERE id = ?').get(botId);
  if(!bot)throw Error('Configured Bot not found');
  const row=db.prepare('SELECT id, metadata_json FROM sessions WHERE id = ?').get(bot.canonical_session_id);
  if(!row)throw Error('Configured Bot session not found');
  const catalogModule=await import(pathToFileURL(join(driverRoot,'packages/core/dist/model/provider-catalog.js')));
  const store={getDaemonControl(key){const r=db.prepare('SELECT value_json FROM daemon_control WHERE key = ?').get(key);return r?JSON.parse(r.value_json):undefined;}};
  const catalog=catalogModule.readModelCatalog(store);
  const selected=catalogModule.resolveSessionPreferredRef(catalog,{id:row.id,metadata:JSON.parse(row.metadata_json??'{}')},env);
  if(selected.overrideSkipped)throw Error('Pinned model unavailable; refusing silent fallback');
  const provider=selected.ref?catalogModule.findProvider(catalog,selected.ref.providerId,env):catalogModule.envFallbackProvider(env);
  const name=selected.ref?.modelId??env.RAW_AGENT_MODEL_NAME;
  if(!provider||provider.kind==='heuristic'||!provider.apiKey||!provider.baseUrl||!name)throw Error('No usable live model configured');
  return {model:{provider:provider.kind,httpKind:provider.httpKind??'chat',useJsonMode:provider.useJsonMode,temperature:0},
   env:{RAW_AGENT_API_KEY:provider.apiKey,RAW_AGENT_BASE_URL:provider.baseUrl,RAW_AGENT_MODEL_NAME:name},
   selection:{botId,source:selected.source,providerId:provider.id,name}};
 }finally{db.close();}
}
