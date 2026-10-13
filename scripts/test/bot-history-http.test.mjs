import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/bot-http-fixture.mjs';
async function conversation(d){const c=await d.call('alice','POST','/api/sessions',{title:'History sources',agentId:'general',autoRun:false});assert.equal(c.status,201);const id=c.body.session.id;for(const message of ['first source','second source','third source'])assert.equal((await d.call('alice','POST',`/api/sessions/${id}/messages`,{message,autoRun:false})).status,200);const p=await d.call('alice','GET',`/api/sessions/${id}/history`);return {id,messages:p.body.messages};}
test('HTTP original history context expands stable sources and rejects missing invalid or foreign references [AC:bot-history-memory#AC-1]',async()=>{
 const d=await boot();try{const {id,messages}=await conversation(d);const mid=messages[1];
 const expanded=await d.call('alice','GET',`/api/sessions/${id}/history/${mid.seq}?before=1&after=1`);assert.equal(expanded.status,200);assert.equal(expanded.body.message.id,mid.id);assert.deepEqual(expanded.body.messages.map(m=>m.id),messages.map(m=>m.id));
 const defaults=await d.call('alice','GET',`/api/sessions/${id}/history/${mid.seq}`);assert.equal(defaults.status,200);assert.equal(defaults.body.messages.length,3);
 assert.equal((await d.call('alice','GET',`/api/sessions/${id}/history/999999`)).status,404);
 assert.equal((await d.call('alice','GET',`/api/sessions/${id}/history/invalid`)).status,400);
 assert.equal((await d.call('bob','GET',`/api/sessions/${id}/history/${mid.seq}`)).status,404);
 }finally{await d.close();}
});
test('HTTP memory sources persist by sequence or message ID and retain provenance after correction [AC:bot-history-memory#AC-4]',async()=>{
 const d=await boot();try{const {id,messages}=await conversation(d),src=messages[1];
 const body={scope:'user.memory',namespace:'semantic',key:'source fact',value:'original fact',sourceRefs:[{sessionId:id,messageId:src.id,seq:src.seq}]};
 const created=await d.call('alice','POST','/api/memory',body);assert.equal(created.status,201);assert.deepEqual(created.body.entry.sourceRefs,body.sourceRefs);
 const corrected=await d.call('alice','POST','/api/memory',{...body,value:'corrected fact',sourceRefs:[{sessionId:id,messageId:src.id}]});assert.equal(corrected.status,201);assert.equal(corrected.body.entry.id,created.body.entry.id);assert.equal(corrected.body.entry.value,'corrected fact');assert.equal(corrected.body.entry.sourceRefs[0].seq,src.seq);
 assert.equal((await d.call('alice','DELETE',`/api/memory/${created.body.entry.id}`)).status,200);
 assert.equal((await d.call('alice','GET',`/api/sessions/${id}/history/${src.seq}`)).body.message.id,src.id);
 }finally{await d.close();}
});
test('HTTP memory source validation rejects forged foreign malformed and absent original messages [AC:bot-history-memory#AC-4]',async()=>{
 const d=await boot();try{const {id,messages}=await conversation(d),src=messages[0];const body={scope:'user.memory',key:'invalid provenance',value:'not accepted'};
 const invalid=[null,{}, {sessionId:id,messageId:123}, {sessionId:id,messageId:'missing'}, {sessionId:id,messageId:src.id,seq:999999}, {sessionId:id,messageId:'wrong-id',seq:src.seq}, {sessionId:id,messageId:src.id,seq:0}, {sessionId:id,messageId:src.id,seq:'not-a-sequence'}, {sessionId:id,messageId:src.id,seq:{toString:'bad'}}];
 for(const ref of invalid){const response=await d.call('alice','POST','/api/memory',{...body,sourceRefs:[ref]});assert.equal(response.status,400,JSON.stringify(ref));}
 assert.equal((await d.call('alice','POST','/api/memory',{...body,sourceRefs:[{sessionId:'missing-session',messageId:src.id}]})).status,404);
 assert.equal((await d.call('bob','POST','/api/memory',{...body,sourceRefs:[{sessionId:id,messageId:src.id,seq:src.seq}]})).status,404);
 assert.equal(d.runtime.store.agentMemory().search({userId:'alice',query:'not accepted'}).length,0);
 }finally{await d.close();}
});
