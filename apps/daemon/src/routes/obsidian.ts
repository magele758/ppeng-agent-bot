import path from 'node:path';
import { type RawAgentRuntime, NotFoundError } from '@ppeng/agent-core';
import { configureVault, resolveVault, vaultSettings } from '../obsidian-settings.js';
import { noteBody, noteTopics, saveConversation, selectedReply } from '../session-obsidian.js';
import { json } from '../http-utils.js';
import { guardSession, listedSessions } from '../session-guard.js';
import type { RouteSpec } from '../routing.js';

export function obsidianRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [{
    method: 'GET', pattern: '/api/obsidian/settings',
    handler: async ({response}) => json(response, 200, await vaultSettings(runtime.store))
  },{
    method: 'PATCH', pattern: '/api/obsidian/settings',
    handler: async ({readBody,response}) => {
      const body = await readBody() as {path?: unknown} | null;
      await configureVault(runtime.store, body?.path);
      json(response, 200, await vaultSettings(runtime.store));
    }
  },{
    method: 'POST', pattern: '/api/sessions/:id/obsidian',
    handler: async ({requireParam,response,auth,readBody}) => {
      const id = requireParam('id');
      const session = guardSession(runtime,id,auth);
      if (!session) throw new NotFoundError('Session');
      const input = await readBody() as {messageIds?: unknown} | null;
      const {messages,title} = selectedReply(runtime.getSessionMessages(id),input?.messageIds);
      const messageIds = messages.map(message=>message.id);
      const body = noteBody(messages);
      const vault = await resolveVault(runtime.store);
      const file = await saveConversation(vault,{...session,title},messages,body,messageIds);
      const note = {id,title,messageIds,file,vault:path.basename(vault),topics:noteTopics(title+'\n'+body)};
      const legacyKey = 'obsidian-note:'+id+':'+file;
      const existing = runtime.store.getDaemonControl<{vault:string}>(legacyKey);
      const key = existing?.vault === note.vault ? legacyKey : 'obsidian-note:'+id+':'+path.join(vault,file);
      runtime.store.setDaemonControl(key,note);
      json(response,200,note);
    }
  },{
    method:'GET',pattern:'/api/obsidian/notes',
    handler:({auth,response})=>{
      const visible = new Set(listedSessions(runtime,auth).map(session=>session.id));
      const rows = runtime.store.db.prepare("SELECT value_json FROM daemon_control WHERE key GLOB 'obsidian-note:*' ORDER BY rowid DESC").all();
      const notes = rows.map(row=>JSON.parse(String(row.value_json))).filter(note=>visible.has(note.id));
      json(response,200,{notes});
    }
  }];
}
