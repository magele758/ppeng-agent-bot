import test from 'node:test';
import assert from 'node:assert/strict';
import { LcuComputerUseProvider } from '../dist/computer-use/lcu-provider.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = []; const clients = [];
  const provider = new LcuComputerUseProvider({
    enabled: () => options.enabled !== false,
    clientFactory: async ({ onElicitation }) => {
      const client = { instructions: 'ORIGINAL CUA INSTRUCTIONS', connect: async () => {}, publicTools: () => [{ name: 'js', description: 'ORIGINAL JS', inputSchema: { type: 'object' } }, { name: 'js_reset', inputSchema: { type: 'object' } }],
        call: async (name, args, ctx) => { calls.push({ name, args, ...ctx }); return options.call ? options.call(name, args, ctx, onElicitation) : { content: [{ type: 'text', text: 'done' }] }; },
        turnEnded: async ctx => calls.push({ ended: ctx }), close: async () => calls.push({ closed: true }) };
      clients.push(client); return client;
    },
    requestApproval: options.requestApproval ?? (async () => ({ action: 'decline' })),
    saveImage: async (_sid, image) => ({ type: 'image', assetId: 'saved-image', mimeType: image.mimeType, alt: 'LCU observation' }),
  });
  return { provider, calls, clients, options };
}
test('desktop tools enable and disable independently [AC:lcu-computer-use#AC-1]', async () => {
  const f = fixture(); await f.provider.beginTurn('s1', 't1');
  assert.equal(f.provider.instructionsForSession('s1'), 'ORIGINAL CUA INSTRUCTIONS');
  assert.deepEqual(f.provider.tools().map(t => t.name), ['lcu_js', 'lcu_js_reset']);
  f.options.enabled = false; assert.deepEqual(f.provider.tools(), []);
  await assert.rejects(f.provider.execute('s1', 'js', { code: 'test' }), /disabled/i);
  await f.provider.endTurn('s1');
});
test('native approval denial is forwarded unchanged [AC:lcu-computer-use#AC-2]', async () => {
  let answer;
  const f = fixture({ call: async (_n, _a, _c, elicit) => { answer = await elicit({ mode: 'form', message: 'Allow TextEdit?', requestedSchema: { type: 'object', properties: {} } }, { signal: new AbortController().signal }); return { isError: true, content: [{ type: 'text', text: 'not approved' }] }; } });
  await f.provider.beginTurn('s1', 't1'); const r = await f.provider.execute('s1', 'js', {});
  assert.deepEqual(answer, { action: 'decline' }); assert.equal(r.ok, false); assert.match(r.content, /not approved/); await f.provider.endTurn('s1');
});
test('screenshots are preserved as model image parts [AC:lcu-computer-use#AC-3]', async () => {
  const f = fixture({ call: async () => ({ content: [{ type: 'text', text: 'saved' }, { type: 'image', mimeType: 'image/png', data: 'BASE64' }] }) });
  await f.provider.beginTurn('s1', 't1'); const r = await f.provider.execute('s1', 'js', {});
  assert.equal(r.images[0].assetId, 'saved-image'); assert.equal(r.metadata.mcpContent[1].data, 'BASE64'); assert.equal(r.content, 'saved'); await f.provider.endTurn('s1');
});
test('session connections and cleanup remain independent [AC:lcu-computer-use#AC-4]', async () => {
  const f = fixture(); await f.provider.beginTurn('s1', 't1'); await f.provider.beginTurn('s2', 't2');
  await f.provider.execute('s1', 'js', {}); await f.provider.endTurn('s1'); await f.provider.execute('s2', 'js', {});
  assert.equal(f.clients.length, 2); assert.deepEqual(f.calls.filter(c => c.name).map(c => [c.sessionId, c.turnId]), [['s1','t1'],['s2','t2']]); await f.provider.endTurn('s2');
});
test('aborted queued operations never reach the desktop [AC:lcu-computer-use#AC-5]', async () => {
  const f = fixture(); await f.provider.beginTurn('s1','t1'); await f.provider.beginTurn('s2','t2'); await f.provider.execute('s1','js',{});
  const controller = new AbortController(); const queued = f.provider.execute('s2','js',{},controller.signal); controller.abort();
  await assert.rejects(queued, /abort/i); assert.equal(f.calls.filter(c=>c.name).length,1);
  await f.provider.endTurn('s1','Interrupt'); await f.provider.endTurn('s2','Interrupt'); assert.equal(f.calls.filter(c=>c.ended).length,2);
});
test('raw runtime failure is retained [AC:lcu-computer-use#AC-6]', async () => {
  const f = fixture({ call: async () => { throw new Error('Sky native pipe startup failed'); } }); await f.provider.beginTurn('s1','t1');
  await assert.rejects(f.provider.execute('s1','js',{}), /Sky native pipe startup failed/); await f.provider.endTurn('s1');
});
test('one desktop turn owns the input lease [AC:lcu-computer-use#AC-7]', async () => {
  const f = fixture(); await f.provider.beginTurn('s1','t1'); await f.provider.beginTurn('s2','t2'); await f.provider.execute('s1','js',{});
  const next = f.provider.execute('s2','js',{}); await new Promise(r=>setTimeout(r,20)); assert.equal(f.calls.filter(c=>c.name).length,1);
  await f.provider.endTurn('s1'); await next; assert.equal(f.calls.filter(c=>c.name).length,2); await f.provider.endTurn('s2');
});

test('Lab approval only forwards the real user decision and cancels on stop [AC:lcu-computer-use#AC-2]', async () => {
  const { createLcuApprovalHandler } = await import('../dist/computer-use/approval.js');
  let row;
  const handler = createLcuApprovalHandler({ createApproval: input => (row={...input,id:'native-approval',status:'pending'}),getApproval:()=>row,updateApproval:(_id,status)=>(row={...row,status}) });
  const params={mode:'form',message:'Allow TextEdit?',requestedSchema:{type:'object',properties:{}},_meta:{connector_id:'computer-use',codex_approval_kind:'mcp_tool_call',tool_params:{app:'com.apple.TextEdit'}}};
  const controller = new AbortController();const pending=handler('s1',params,controller.signal);
  assert.equal(row.sessionId,'s1');assert.deepEqual(row.args.originalRequest,params);
  row.status='approved';assert.deepEqual(await pending,{action:'accept',content:{}});
  const cancelled=handler('s2',params,controller.signal);controller.abort();assert.deepEqual(await cancelled,{action:'cancel'});assert.equal(row.status,'rejected');
  row=undefined;assert.deepEqual(await handler('s1',{...params,requestedSchema:{type:'object',properties:{secret:{type:'string'}}}},new AbortController().signal),{action:'cancel'});assert.equal(row,undefined);
});
test('cleanup failure blocks future desktop input [AC:lcu-computer-use#AC-5]', async () => {
  const f=fixture();await f.provider.beginTurn('s1','t1');await f.provider.beginTurn('s2','t2');await f.provider.execute('s1','js',{});
  f.clients[0].turnEnded=async()=>{throw new Error('cleanup timeout')};const next=f.provider.execute('s2','js',{});const rejection=assert.rejects(next,/cleanup failed/);
  await assert.rejects(f.provider.endTurn('s1'),/cleanup failed/);await rejection;await f.provider.endTurn('s2');
});

test('runtime delivers original instructions and ingested images to model, then hides disabled tools [AC:lcu-computer-use#AC-1] [AC:lcu-computer-use#AC-3]', async () => {
  const { RawAgentRuntime }=await import('../dist/runtime.js');const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  let turns=0;const inputs=[];let cleanup=0;
  const model={name:'lcu-contract-test',runTurn:async input=>{inputs.push(input);return ++turns===1?{stopReason:'tool_calls',assistantParts:[{type:'tool_call',toolCallId:'screenshot-call',name:'lcu_js',input:{code:'fixture'}}]}:{stopReason:'end',assistantParts:[{type:'text',text:'seen'}]};},summarizeMessages:async()=>''};
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'lcu-repo-')),stateDir:mkdtempSync(join(tmpdir(),'lcu-state-')),modelAdapter:model,computerUseClientFactory:async()=>({connect:async()=>{},instructions:'ORIGINAL CUA INSTRUCTIONS',publicTools:()=>[{name:'js',description:'original tool',inputSchema:{type:'object',properties:{code:{type:'string'}}}}],call:async()=>({content:[{type:'text',text:'image captured'},{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6k9sAAAAASUVORK5CYII='}]}),turnEnded:async()=>{cleanup++},close:async()=>{}})});
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  try{rt.store.setDaemonControl('computer_use_settings',{enabled:true});const session=rt.store.createSession({title:'LCU integration',mode:'chat',agentId:'general',background:false,metadata:{permissionMode:'auto'}});rt.store.appendMessage(session.id,'user',[{type:'text',text:'Take a screenshot'}]);await rt.runSession(session.id);
  assert.equal(inputs.length,2);assert.ok(inputs[0].systemPrompt.includes('ORIGINAL CUA INSTRUCTIONS'));const part=inputs[1].messages.flatMap(m=>m.parts).find(p=>p.type==='image');assert.ok(part,'screenshot must reach provider input');assert.ok(rt.store.getImageAsset(part.assetId));assert.equal(cleanup,1);
  rt.store.setDaemonControl('computer_use_settings',{enabled:false});rt.store.appendMessage(session.id,'user',[{type:'text',text:'ordinary chat'}]);await rt.runSession(session.id);assert.ok(inputs.at(-1).tools.every(t=>!t.name.startsWith('lcu_')));
  }finally{await rt.destroy();}
});

test('transport close failure blocks rather than leaving queued turns hanging [AC:lcu-computer-use#AC-5]', async () => {
  const f=fixture();await f.provider.beginTurn('s1','t1');await f.provider.beginTurn('s2','t2');await f.provider.execute('s1','js',{});
  f.clients[0].close=async()=>{throw new Error('close failed')};const pending=f.provider.execute('s2','js',{});const rejected=assert.rejects(pending,/close failed/);
  await assert.rejects(f.provider.endTurn('s1'),/close failed/);await rejected;await f.provider.endTurn('s2');
});
