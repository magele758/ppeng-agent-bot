import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { writeSkillProposalSettings } from '../dist/skill-proposals/index.js';
import { resolveSkillLoad, resolveSkillSearch } from '../dist/runtime/skill-load.js';
import { skillProposalRoutes } from '../../../apps/daemon/dist/routes/skill-proposals.js';

const ANON={isolate:false,labProxy:false,user:null};
test('runtime intent -> session route confirmation -> searchable and loadable without second review', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'skill-capture-http-'));
  let completions=0;
  const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{
    name:'capture-test',runTurn:async()=>({stopReason:'end',assistantParts:[]}),summarizeMessages:async()=>'',
    completeText:async input=>{completions++;assert.match(input.user,/Successfully verified/);return JSON.stringify({description:'Verify release checks',body:'# Release\nRun checks and verify the release health endpoint.'});}
  }});
  t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true});});
  writeSkillProposalSettings(runtime.store,{enabled:true,remindEveryNToolCalls:10});
  const session=runtime.store.createSession({title:'capture',mode:'chat',agentId:'general'});
  runtime.sendUserMessage(session.id,'Successfully verified release checks.',{autoRun:false});
  const tool=runtime.tools.find(t=>t.name==='skill_propose');
  const result=await tool.execute({session,agent:{id:'general'}},{name:'http-release-check',description:'Verify releases',reason:'The release checks succeeded',summary:'Record release checks and health validation'});
  assert.equal(result.ok,true,result.content);
  const {capture}=JSON.parse(result.content);assert.equal(completions,0);
  async function request(action,id=session.id){
    const pattern=action==='list'?'/api/sessions/:id/skill-captures':`/api/sessions/:id/skill-captures/:captureId/${action}`;
    const route=skillProposalRoutes(runtime).find(r=>r.pattern===pattern);
    let payload;
    await route.handler({auth:ANON,requireParam:key=>key==='id'?id:capture.id,response:{setHeader(){},end(s){payload=JSON.parse(s)}},readBody:async()=>({})});
    return payload;
  }
  const listing=await request('list');
  assert.equal(listing.captures[0].evidence,undefined);assert.equal(listing.captures[0].existingContent,undefined);
  await assert.rejects(request('confirm','nonexistent-session'));
  const saved=await request('confirm');assert.equal(saved.capture.status,'saved',saved.capture.error);assert.equal(completions,1);
  await request('confirm');assert.equal(completions,1);
  const host={promptBuilder:runtime.promptBuilder,emitTrace(){}};
  const searched=JSON.parse((await resolveSkillSearch(host,'http-release-check',session.id)).content);
  assert.ok(searched.hits.some(h=>h.name==='http-release-check'));
  const loaded=await resolveSkillLoad(host,'http-release-check',session.id);assert.match(loaded.content,/health endpoint/);
});

test('bot skill selection patch saves the current revision and rejects a stale one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-selection-patch-'));
  const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'idle', runTurn: async () => ({ stopReason: 'end', assistantParts: [] }), summarizeMessages: async () => ''
  } });
  t.after(async () => { await runtime.destroy(); rmSync(dir, { recursive: true, force: true }); });
  const bot = runtime.createBot({ name: 'SkillBot' });
  const routes = skillProposalRoutes(runtime);
  const get = routes.find(route => route.method === 'GET' && route.pattern === '/api/bots/:id/skills');
  const patch = routes.find(route => route.method === 'PATCH' && route.pattern === '/api/bots/:id/skills');
  async function call(route, body) {
    let payload;
    let status = 200;
    await route.handler({
      auth: ANON,
      requireParam: () => bot.id,
      readBody: async () => body,
      response: { setHeader() {}, end(raw) { payload = JSON.parse(raw); }, writeHead(code) { status = code; } }
    });
    return { payload, status };
  }
  const current = await call(get);
  assert.equal(current.payload.policy.mode, 'all');
  await assert.rejects(() => call(patch, { policy: { mode: 'all', ids: [] }, revision: 'stale' }), /Skill settings changed/);
  await assert.rejects(() => call(patch, { policy: { mode: 'custom', ids: [] }, revision: current.payload.revision }), /Invalid skill selection/);
  const saved = await call(patch, { policy: { mode: 'selected', ids: [] }, revision: current.payload.revision });
  assert.equal(saved.payload.policy.mode, 'selected');
  assert.deepEqual(saved.payload.policy.ids, []);
});

test('assembled Bot host reminds after ten tool iterations, not ten parallel calls [AC:skill-capture-intent-confirmation#AC-1]', async t=>{
  const {l5ToAssembledIo}=await import('../dist/runtime/l5-bindings.js');
  const dir=mkdtempSync(join(tmpdir(),'skill-capture-reminder-'));
  const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'idle',runTurn:async()=>({stopReason:'end',assistantParts:[]}),summarizeMessages:async()=>''}});
  t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true});});
  writeSkillProposalSettings(runtime.store,{enabled:true,remindEveryNToolCalls:10});
  runtime.promptBuilder.buildMemoryAppendixAsync=async()=>'';
  const session=runtime.store.createSession({title:'reminders',mode:'chat',agentId:'general'});
  const io=l5ToAssembledIo(runtime.l5(),session.id);
  const ctx={sessionId:session.id,session,agent:{id:'general'},repoRoot:dir};
  for(let turn=0;turn<9;turn++) io.recordToolUse({sessionId:session.id,turn,name:'load_skill',ok:true});
  for(let i=0;i<10;i++) io.recordToolUse({sessionId:session.id,turn:8,name:'load_skill',ok:true});
  assert.doesNotMatch(await io.promptBuilder.buildMemoryAppendix(ctx),/skill-review reminder/);
  io.recordToolUse({sessionId:session.id,turn:9,name:'load_skill',ok:true});
  assert.match(await io.promptBuilder.buildMemoryAppendix(ctx),/confirmation BEFORE distillation/);
});
