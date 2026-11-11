import type {SqliteStateStore} from '../storage.js';
import {resetActiveSkillManifests} from './skill-manifest-gate.js';

/** A skill ceiling belongs to one ordinary request, including retries and steering. */
export function beginSkillTask(store:SqliteStateStore,sessionId:string):void {
 const session=store.getSession(sessionId);
 if(!session)return;
 const request=store.db.prepare(`SELECT id,seq FROM session_messages WHERE session_id=? AND role='user'
   AND (key IS NULL OR (key NOT LIKE '%steer%' AND key NOT LIKE '%note%')) ORDER BY seq DESC LIMIT 1`).get(sessionId) as {id:string;seq:number}|undefined;
 if(!request||session.metadata.activeSkillManifestTaskId===request.id)return;
 const preserve=legacyManifestBelongsToRequest(store,sessionId,session.metadata,request.seq);
 resetExpiredManifests(sessionId,preserve);
 store.updateSession(sessionId,{metadata:{...session.metadata,activeSkillManifestTaskId:request.id,
   ...(!preserve?{activeSkillManifests:[]}:{}),}});
}

function legacyManifestBelongsToRequest(store:SqliteStateStore,sessionId:string,metadata:Record<string,unknown>,seq:number):boolean {
 if(metadata.activeSkillManifestTaskId)return false;
 // Older releases had no scope marker. Keep restrictions when a load occurred
 // after this request; a process restart alone must never widen its permissions.
 const loaded=store.db.prepare(`SELECT seq FROM session_messages,json_each(parts_json) AS part
   WHERE session_id=? AND role='assistant'
   AND json_extract(part.value,'$.type')='tool_call'
   AND json_extract(part.value,'$.name')='load_skill' ORDER BY seq DESC LIMIT 1`).get(sessionId) as {seq:number}|undefined;
 return !loaded || loaded.seq>seq;
}

function resetExpiredManifests(sessionId:string,preserve:boolean):void {
 if(!preserve)resetActiveSkillManifests(sessionId);
}
