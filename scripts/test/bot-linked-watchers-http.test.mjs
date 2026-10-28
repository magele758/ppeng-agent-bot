import test from 'node:test';
import assert from 'node:assert/strict';
import {boot} from './helpers/bot-http-fixture.mjs';
import {BotGoalService} from '../../packages/core/dist/bots/goals/service.js';
test('authenticated HTTP saves, edits and clears only owned work links [AC:bot-linked-watchers#AC-1] [AC:bot-linked-watchers#AC-6]',{timeout:30000},async t=>{
 const f=await boot();t.after(()=>f.close());
 const created=await f.call('alice','POST','/api/bots',{name:'Linked HTTP'});assert.equal(created.status,201);
 const bot=created.body.bot,opened=await f.call('alice','POST',`/api/bots/${bot.id}/open`),sid=opened.body.session.id;
 const goals=new BotGoalService(f.runtime.store,Date.now,sid),goal=goals.create({botId:bot.id,sessionId:sid,title:'Deliver',objective:'Build and merge'});
 const r=await f.call('alice','POST','/api/cron/jobs',{botId:bot.id,name:'watch',prompt:'check',intervalMs:60000,workLink:{goalId:goal.id}});
 assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.job.metadata.workLink.goalId,goal.id);
 const bad=await f.call('alice','PATCH',`/api/cron/jobs/${r.body.job.id}`,{workLink:{goalId:'missing'}});assert.equal(bad.status,400);
 assert.equal(f.runtime.getCronJob(r.body.job.id).metadata.workLink.goalId,goal.id);
 const foreign=await f.call('bob','POST','/api/cron/jobs',{botId:bot.id,name:'foreign',prompt:'check',intervalMs:60000,workLink:{goalId:goal.id}});assert.ok(foreign.status>=400);
 const cleared=await f.call('alice','PATCH',`/api/cron/jobs/${r.body.job.id}`,{workLink:null});assert.equal(cleared.status,200);assert.equal(cleared.body.job.metadata.workLink,undefined);
});
