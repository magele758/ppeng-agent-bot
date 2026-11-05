import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime, resolveBotPrincipal, RoutineRunStore} from '@ppeng/agent-core';
import {deleteBotPreservingHistory} from '../dist/bot-delete.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'delete-bot-'));
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'test',async runTurn(){return {stopReason:'end',assistantParts:[]};},async summarizeMessages(){return '';}}});
 return {runtime,close(){runtime.store.db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('删除 Bot 保留历史且清除定时任务 [AC:bot-delete#AC-1]',()=>{
 const f=fixture();try{
 const bot=f.runtime.createBot({name:'Disposable'});
 const job=f.runtime.createCronJob({botId:bot.id,name:'Reminder',prompt:'hello',scheduleKind:'every_ms',scheduleValue:'3600000'});
 const sid=bot.canonicalSessionId;
 const other=f.runtime.createBot({name:'Other'});
 const principal=resolveBotPrincipal(f.runtime.store);
 const room=f.runtime.rooms.create(principal,{title:'History',botIds:[bot.id,other.id]});
 f.runtime.store.db.prepare('INSERT INTO bot_room_messages(id,room_id,seq,data) VALUES(?,?,?,?)').run('old-message',room.id,1,JSON.stringify({id:'old-message',text:'Keep this',roomId:room.id,seq:1}));
 f.runtime.store.appendMessage(sid,'user',[{type:'text',text:'Keep conversation'}]);
 const run=new RoutineRunStore(f.runtime.store).enqueue(job,new Date().toISOString());
 deleteBotPreservingHistory(f.runtime,bot.id);
 assert.equal(f.runtime.store.getBot(bot.id),undefined);
 assert.ok(f.runtime.store.getSession(sid));
 assert.equal(f.runtime.store.getSession(sid)?.metadata.autonomous,false);
 assert.ok(!f.runtime.listCronJobs().some(j=>j.id===job.id));
 assert.equal(new RoutineRunStore(f.runtime.store).get(run.id)?.status,'cancelled');
 assert.equal(f.runtime.rooms.messages(principal,room.id).messages[0].text,'Keep this');
 assert.deepEqual(f.runtime.rooms.get(principal,room.id).botIds,[other.id]);
 assert.equal(f.runtime.rooms.get(principal,room.id).status,'paused');
 assert.equal(f.runtime.store.listMessages(sid)[0].parts[0].text,'Keep conversation');
 }finally{f.close();}
});
test('运行中拒绝删除 [AC:bot-delete#AC-2]',()=>{
 const f=fixture();try{
 const bot=f.runtime.createBot({name:'Busy'});
 f.runtime.store.updateSession(bot.canonicalSessionId,{status:'running'});
 assert.throws(()=>deleteBotPreservingHistory(f.runtime,bot.id),/running/i);
 assert.ok(f.runtime.store.getBot(bot.id));
 }finally{f.close();}
});
