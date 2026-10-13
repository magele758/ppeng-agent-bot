import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/bot-http-fixture.mjs';
test('logged HTTP users see shared Bot definitions but never installation private history [AC:bot-identity-continuity#AC-1]',async()=>{
 const d=await boot();try{const shared=d.runtime.createBot({name:'Shared worker'});d.runtime.store.appendMessage(shared.canonicalSessionId,'user',[{type:'text',text:'INSTALLATION PRIVATE HISTORY'}]);
 const list=await d.call('alice','GET','/api/bots');assert.equal(list.status,200);assert.ok(list.body.bots.some(bot=>bot.id===shared.id));
 const opened=await d.call('alice','POST',`/api/bots/${shared.id}/open`);assert.equal(opened.status,200);assert.equal(opened.body.session.metadata.userId,'alice');assert.notEqual(opened.body.session.id,shared.canonicalSessionId);
 const bob=await d.call('bob','POST',`/api/bots/${shared.id}/open`);assert.equal(bob.status,200);assert.notEqual(opened.body.session.id,bob.body.session.id);
 assert.ok([403,404].includes((await d.call('alice','GET',`/api/sessions/${shared.canonicalSessionId}/history`)).status));
 assert.ok([403,404].includes((await d.call('bob','GET',`/api/sessions/${opened.body.session.id}/history`)).status));
 }finally{await d.close();}
});
test('HTTP owner can repair deleted private canonical and foreign users remain denied [AC:bot-identity-continuity#AC-1]',async()=>{
 const d=await boot();try{
 const created=await d.call('alice','POST','/api/bots',{name:'Private definition'});assert.equal(created.status,201);const bot=created.body.bot;
 const removed=await d.call('alice','DELETE',`/api/sessions/${bot.canonicalSessionId}`);assert.equal(removed.status,200);
 assert.ok([403,404].includes((await d.call('bob','GET',`/api/bots/${bot.id}`)).status));
 assert.ok([403,404].includes((await d.call('bob','POST',`/api/bots/${bot.id}/open`)).status));
 assert.ok((await d.call('alice','GET','/api/bots')).body.bots.some(b=>b.id===bot.id));
 const repair=await d.call('alice','POST',`/api/bots/${bot.id}/open`);assert.equal(repair.status,200);assert.equal(repair.body.session.metadata.userId,'alice');assert.notEqual(repair.body.session.id,bot.canonicalSessionId);
 const repeat=await d.call('alice','POST',`/api/bots/${bot.id}/open`);assert.equal(repeat.status,200);assert.equal(repeat.body.session.id,repair.body.session.id);
 assert.ok([403,404].includes((await d.call('bob','POST',`/api/bots/${bot.id}/open`)).status));
 }finally{await d.close();}
});
test('v24 private owner evidence migrates before HTTP canonical deletion [AC:bot-identity-continuity#AC-1]',async()=>{
 const d=await boot(true);try{const bot=d.runtime.getBot('researcher');
 const anchor=d.runtime.store.db.prepare('SELECT principal FROM bot_definition_owners WHERE bot_id=?').get(bot.id);assert.deepEqual(JSON.parse(anchor?.principal??'null'),['tenant','alice']);
 assert.equal((await d.call('alice','DELETE',`/api/sessions/${bot.canonicalSessionId}`)).status,200);
 assert.ok([403,404].includes((await d.call('bob','GET',`/api/bots/${bot.id}`)).status));
 const repair=await d.call('alice','POST',`/api/bots/${bot.id}/open`);assert.equal(repair.status,200);assert.equal(repair.body.session.metadata.userId,'alice');
 }finally{await d.close();}
});
