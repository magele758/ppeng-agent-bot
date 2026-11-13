import path from 'node:path';
import { type RawAgentRuntime, NotFoundError } from '@ppeng/agent-core';
import { activeVault, noteBody, noteTopics, saveConversation } from '../session-obsidian.js';
import { json } from '../http-utils.js';
import { guardSession, listedSessions } from '../session-guard.js';
import type { RouteSpec } from '../routing.js';

export function obsidianRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [{
    method: 'POST', pattern: '/api/sessions/:id/obsidian',
    handler: async ({requireParam,response,auth}) => {
      const id = requireParam('id');
      const session = guardSession(runtime,id,auth);
      if (!session) throw new NotFoundError('Session');
      const messages = runtime.getSessionMessages(id);
      const body = noteBody(messages);
      const vault = await activeVault();
      const file = await saveConversation(vault,session,messages,body);
      const note = {id,title:session.title || id,file,vault:path.basename(vault),topics:noteTopics(session.title+'\n'+body)};
      runtime.store.setDaemonControl('obsidian-note:'+id+':'+file,note);
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
