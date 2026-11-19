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
  const handler = createLcuApprovalHandler({ createApproval: input => (row={...input,id:'native-approval',status:'pending'}),getApproval:()=>row,updateApproval:(_id,status)=>(row={...row,status}),getDaemonControl:()=>undefined,setDaemonControl:()=>{} });
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

const appRequest=(app='com.apple.VoiceMemos',persist=['session','always'])=>({mode:'form',message:`Allow Computer Use to use "${app}"?`,requestedSchema:{type:'object',properties:{}},_meta:{connector_id:'computer-use',codex_approval_kind:'mcp_tool_call',persist,tool_params:{app}}});
function grantFixture(policy){
  const rows=[];const control=new Map();
  const store={createApproval:input=>{const row={...input,id:`a${rows.length}`,status:'pending'};rows.push(row);return row;},getApproval:id=>rows.find(r=>r.id===id),updateApproval:(id,status)=>Object.assign(rows.find(r=>r.id===id),{status}),
    getDaemonControl:key=>control.get(key),setDaemonControl:(key,value)=>control.set(key,value)};
  return {rows,control,store,policy:{autoAllow:()=>false,userAuthority:()=>true,...policy}};
}
async function decide(rows,handler,sid,params,status){const pending=handler(sid,params,new AbortController().signal);await new Promise(r=>setTimeout(r,5));rows.at(-1).status=status;return pending;}

test('bypass root user session allows app access without a Lab approval [AC:lcu-app-grant#AC-1]', async () => {
  const { createLcuApprovalHandler } = await import('../dist/computer-use/approval.js');
  const f=grantFixture({autoAllow:sid=>sid==='root'});const handler=createLcuApprovalHandler(f.store,f.policy);
  assert.deepEqual(await handler('root',appRequest(),new AbortController().signal),{action:'accept',content:{},_meta:{persist:'session'}});
  assert.deepEqual(await handler('root',appRequest('com.apple.TextEdit',[]),new AbortController().signal),{action:'accept',content:{}});
  assert.equal(f.rows.length,0);
});
test('one approval is remembered for the same app in the same session only [AC:lcu-app-grant#AC-2]', async () => {
  const { createLcuApprovalHandler } = await import('../dist/computer-use/approval.js');
  const f=grantFixture();const handler=createLcuApprovalHandler(f.store,f.policy);
  assert.deepEqual(await decide(f.rows,handler,'s1',appRequest(),'approved'),{action:'accept',content:{},_meta:{persist:'session'}});
  assert.deepEqual(await handler('s1',appRequest(),new AbortController().signal),{action:'accept',content:{},_meta:{persist:'session'}});
  assert.equal(f.rows.length,1);
  const other=handler('s1',appRequest('com.apple.TextEdit'),new AbortController().signal);await new Promise(r=>setTimeout(r,5));assert.equal(f.rows.length,2);f.rows[1].status='rejected';await other;
  const otherSession=handler('s2',appRequest(),new AbortController().signal);await new Promise(r=>setTimeout(r,5));assert.equal(f.rows.length,3);f.rows[2].status='rejected';await otherSession;
});
test('non-bypass routine or delegated authority never reuses grants [AC:lcu-app-grant#AC-3]', async () => {
  const { createLcuApprovalHandler } = await import('../dist/computer-use/approval.js');
  const f=grantFixture({userAuthority:()=>false});const handler=createLcuApprovalHandler(f.store,f.policy);
  await decide(f.rows,handler,'s1',appRequest(),'approved');
  assert.deepEqual(await decide(f.rows,handler,'s1',appRequest(),'rejected'),{action:'decline'});
  assert.equal(f.rows.length,2);
});
test('denials and unsupported requests are not remembered [AC:lcu-app-grant#AC-4]', async () => {
  const { createLcuApprovalHandler } = await import('../dist/computer-use/approval.js');
  const f=grantFixture({autoAllow:()=>true});const handler=createLcuApprovalHandler(f.store,f.policy);
  const bad=appRequest();bad.requestedSchema={type:'object',properties:{secret:{type:'string'}}};
  assert.deepEqual(await handler('s1',bad,new AbortController().signal),{action:'cancel'});
  const g=grantFixture();const h=createLcuApprovalHandler(g.store,g.policy);
  assert.deepEqual(await decide(g.rows,h,'s1',appRequest(),'rejected'),{action:'decline'});
  await decide(g.rows,h,'s1',appRequest(),'rejected');assert.equal(g.rows.length,2);
});
test('runtime respects explicit bypass for root and delegated sessions [AC:lcu-app-grant#AC-1] [AC:bypass-full-auto#AC-5]', async () => {
  const { RawAgentRuntime }=await import('../dist/runtime.js');const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const answers=[];let calls=0;
  const model={name:'lcu-grant-test',runTurn:async input=>input.messages.at(-1).role==='tool'?{stopReason:'end',assistantParts:[{type:'text',text:'done'}]}:{stopReason:'tool_calls',assistantParts:[{type:'tool_call',toolCallId:`c${++calls}`,name:'lcu_js',input:{code:'x'}}]},summarizeMessages:async()=>''};
  const rt=new RawAgentRuntime({repoRoot:mkdtempSync(join(tmpdir(),'lcu-repo-')),stateDir:mkdtempSync(join(tmpdir(),'lcu-state-')),modelAdapter:model,computerUseClientFactory:async({onElicitation})=>({connect:async()=>{},instructions:'',publicTools:()=>[{name:'js',inputSchema:{type:'object'}}],call:async()=>{answers.push(await onElicitation(appRequest(),{signal:new AbortController().signal}));return {content:[{type:'text',text:'ok'}]};},turnEnded:async()=>{},close:async()=>{}})});
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});rt.store.setDaemonControl('computer_use_settings',{enabled:true});
  try{
    const root=rt.store.createSession({title:'bypass',mode:'chat',agentId:'general',background:false,metadata:{permissionMode:'bypass'}});rt.store.appendMessage(root.id,'user',[{type:'text',text:'open voice memos'}]);await rt.runSession(root.id);
    assert.deepEqual(answers.at(-1),{action:'accept',content:{},_meta:{persist:'session'}});assert.equal(rt.listApprovals().filter(a=>a.toolName==='lcu_app_access').length,0);
    const child=rt.store.createSession({title:'child',mode:'subagent',agentId:'general',parentSessionId:root.id,background:false,metadata:{permissionMode:'bypass'}});rt.store.appendMessage(child.id,'user',[{type:'text',text:'open voice memos'}]);
    await rt.runSession(child.id); assert.deepEqual(answers.at(-1),{action:'accept',content:{},_meta:{persist:'session'}}); assert.equal(rt.listApprovals().filter(a=>a.toolName==='lcu_app_access').length,0);
  }finally{await rt.destroy();}
});

test('warm text-only turns retain the discovered desktop surface without any new clients [AC:lcu-chat-startup#AC-1]', async () => {
  const f = fixture();
  await f.provider.beginTurn('first', 'cold');
  const published = f.provider.tools().map(({name,description,inputSchema}) => ({name,description,inputSchema}));
  await f.provider.endTurn('first');
  for (const session of ['ordinary', 'bot']) {
    await f.provider.beginTurn(session, 'warm');
    assert.equal(f.provider.instructionsForSession(session), 'ORIGINAL CUA INSTRUCTIONS');
    assert.deepEqual(f.provider.tools().map(({name,description,inputSchema}) => ({name,description,inputSchema})), published);
    await f.provider.endTurn(session);
  }
  assert.equal(f.clients.length, 1);
  assert.equal(f.calls.filter(call => call.closed).length, 1);
});

test('a warm desktop turn connects on demand using its own approval and cleanup [AC:lcu-chat-startup#AC-2]', async () => {
  const approvals = [];
  const f = fixture({
    requestApproval: async (sessionId) => { approvals.push(sessionId); return { action: 'accept' }; },
    call: async (_name, _args, ctx, elicit) => {
      await elicit({ mode: 'form' }, { signal: ctx.signal });
      return {content: []};
    },
  });
  await f.provider.beginTurn('text', 'first');
  await f.provider.endTurn('text');
  await f.provider.beginTurn('work', 'second');
  assert.equal(f.clients.length, 1);
  await f.provider.execute('work', 'js', {});
  await f.provider.execute('work', 'js_reset', {});
  await f.provider.endTurn('work', 'Interrupt');
  assert.equal(f.clients.length, 2);
  assert.deepEqual(approvals, ['work','work']);
  assert.deepEqual(f.calls.filter(call => call.ended).at(-1).ended, {sessionId:'work',turnId:'second',event:'Interrupt'});
});

test('changed desktop installations are rediscovered and discovery failures can be retried [AC:lcu-chat-startup#AC-3]', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(),'lcu-surface-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  let command;
  let serial = 0;
  function install(dir, version) {
    mkdirSync(join(dir,'bin'),{recursive:true});
    mkdirSync(join(dir,'adapters'),{recursive:true});
    command = join(dir,'bin','lcu');
    writeFileSync(command,version);
    const adapter = 'export function createCuaClient(){return {instructions:'+JSON.stringify(version)+',connect:async()=>{},publicTools:()=>[{name:"js",description:'+JSON.stringify(version)+'}],turnEnded:async()=>{},close:async()=>{}}}';
    writeFileSync(join(dir,'adapters','client.mjs'),adapter);
  }
  const provider = new LcuComputerUseProvider({enabled:()=>true,command:()=>command});
  async function inspect(version) {
    const sid = 's'+(++serial);
    await provider.beginTurn(sid,'t');
    assert.equal(provider.instructionsForSession(sid),version);
    assert.equal(provider.tools()[0].description,version);
    await provider.endTurn(sid);
  }
  install(join(root,'one'),'a'); await inspect('a');
  install(join(root,'two'),'b'); await inspect('b');
  install(join(root,'two'),'c-stable-update'); await inspect('c-stable-update');
  const app = join(root,'ChatGPT.app');
  mkdirSync(join(app,'Contents'),{recursive:true});
  const versionPath = join(app,'Contents','Info.plist');
  symlinkSync(app,join(root,'two','app'));
  writeFileSync(versionPath,'host A');
  const dynamicAdapter = 'import {readFileSync} from "node:fs"; const version=readFileSync('+JSON.stringify(versionPath)+',"utf8"); export function createCuaClient(){return {instructions:version,connect:async()=>{},publicTools:()=>[{name:"js",description:version}],turnEnded:async()=>{},close:async()=>{}}}';
  writeFileSync(join(root,'two','adapters','client.mjs'),dynamicAdapter);
  await inspect('host A');
  writeFileSync(versionPath,'host B updated in place');
  await inspect('host B updated in place');
  command = join(root,'missing','bin','lcu');
  await assert.rejects(provider.beginTurn('retry','t'));
  install(join(root,'missing'),'repaired'); await inspect('repaired');
});

test('simultaneous cold starts share discovery and retry a failed handshake [AC:lcu-chat-startup#AC-1] [AC:lcu-chat-startup#AC-3]', async () => {
  const connected = deferred();
  let attempts = 0;
  let closes = 0;
  const provider = new LcuComputerUseProvider({
    enabled: () => true,
    clientFactory: async () => {
      const attempt = ++attempts;
      return {
        instructions: 'discovered',
        connect: async () => {
          await connected.promise;
          if (attempt === 1) throw new Error('first handshake failed');
        },
        publicTools: () => [{ name: 'js' }],
        turnEnded: async () => {},
        close: async () => { closes++; },
      };
    },
  });
  const first = provider.beginTurn('first','t1');
  const second = provider.beginTurn('second','t2');
  connected.resolve();
  const failures = await Promise.allSettled([first,second]);
  assert.deepEqual(failures.map(f => f.reason.message), ['first handshake failed','first handshake failed']);
  assert.equal(attempts, 1);
  assert.equal(closes, 1);
  await Promise.all([provider.beginTurn('first','retry'),provider.beginTurn('second','retry')]);
  assert.equal(attempts, 2);
  assert.equal(provider.instructionsForSession('second'), 'discovered');
  await provider.close();
  assert.equal(closes, 2);
});

test('replacement tools reach the runtime catalog and warm turns cannot act through a changed installation [AC:lcu-chat-startup#AC-3]', async () => {
  let command = '/v1';
  const provider = new LcuComputerUseProvider({
    enabled: () => true,
    command: () => command,
    clientFactory: async () => ({
      instructions: command,
      connect: async () => {},
      publicTools: () => command === '/v1' ? [{name:'js'},{name:'js_reset'}] : [{name:'js'}],
      turnEnded: async () => {},
      close: async () => {},
    }),
  });
  await provider.beginTurn('cold','t');
  const catalog = [{name:'other'},{name:'lcu_extra'}];
  provider.registerTools(catalog);
  await provider.endTurn('cold');
  await provider.beginTurn('active','t1');
  command = '/v2';
  await assert.rejects(provider.execute('active','js',{}), /installation changed/);
  await provider.beginTurn('replacement','t2');
  provider.registerTools(catalog);
  assert.deepEqual(catalog.map(t=>t.name), ['other','lcu_extra','lcu_js']);
  await assert.rejects(provider.execute('replacement','js_reset',{}), /not available/);
  await provider.close();
});

test('cancelled warm calls do not connect and concurrent desktop actions use one client [AC:lcu-chat-startup#AC-2]', async () => {
  const f = fixture();
  await f.provider.beginTurn('cold','t');
  await f.provider.endTurn('cold');
  await f.provider.beginTurn('warm','t');
  await assert.rejects(f.provider.execute('warm','js',{},AbortSignal.abort()), /abort/i);
  assert.equal(f.clients.length,1);
  await Promise.all([f.provider.execute('warm','js',{}), f.provider.execute('warm','js_reset',{})]);
  assert.equal(f.clients.length,2);
  assert.deepEqual(f.calls.filter(c => c.name).map(c => c.name),['js','js_reset']);
  await f.provider.close();
});

test('late discovery for a previous installation preserves the newer tool catalog [AC:lcu-chat-startup#AC-3]', async () => {
  let command='/old';
  const oldConnect=deferred();
  const provider=new LcuComputerUseProvider({
    enabled:()=>true, command:()=>command,
    clientFactory:async()=>{
      const version=command;
      return {
        instructions:version,
        connect:async()=>{if(version==='/old') await oldConnect.promise;},
        publicTools:()=>[{name:'js',description:version}],
        turnEnded:async()=>{}, close:async()=>{},
      };
    },
  });
  const old=provider.beginTurn('first','t1');
  command='/new';
  await provider.beginTurn('second','t2');
  oldConnect.resolve();
  await old;
  assert.equal(provider.instructionsForSession('first'),'/old');
  assert.equal(provider.instructionsForSession('second'),'/new');
  const global = [];
  provider.registerTools(global);
  assert.equal(global[0].description,'/new');
  assert.equal(provider.toolsForSession(global,'first')[0].description,'/old');
  assert.equal(provider.toolsForSession(global,'second')[0].description,'/new');
  assert.equal(global[0].description,'/new');
  await provider.close();
});

test('stopping during a lazy desktop handshake releases the turn from both cancellation paths [AC:lcu-chat-startup#AC-2]', async () => {
  const waiting = deferred();
  const connecting = deferred();
  let clients = 0;
  const closed = [];
  const actions = [];
  const provider = new LcuComputerUseProvider({
    enabled: () => true,
    clientFactory: async () => {
      const n = ++clients;
      return {
        instructions:'discovered', publicTools:()=>[{name:'js'}],
        connect:async()=>{ if(n===2){ connecting.resolve(); await waiting.promise; } },
        call:async()=>{actions.push(n); return {content:[]};},
        turnEnded:async()=>{}, close:async()=>{closed.push(n);},
      };
    },
  });
  await provider.beginTurn('first','cold');
  await provider.endTurn('first');
  await provider.beginTurn('second','warm');
  const stop = new AbortController();
  const blocked = provider.execute('second','js',{},stop.signal);
  const rejected = assert.rejects(blocked,/abort/i);
  await connecting.promise;
  stop.abort();
  const timer = setTimeout(()=>waiting.resolve(),1500);
  try {
    const before=Date.now();
    await rejected;
    await Promise.all([provider.endTurn('second','Interrupt'),provider.endTurn('second','Interrupt')]);
    assert.ok(Date.now()-before<1000,'interrupt waited for the blocked handshake');
    assert.deepEqual(closed,[1,2]);
    assert.deepEqual(actions,[]);
    waiting.resolve();
    await provider.beginTurn('third','works');
    await provider.execute('third','js',{});
    await provider.endTurn('third');
    assert.deepEqual(closed,[1,2,3]);
    assert.deepEqual(actions,[3]);
  } finally {clearTimeout(timer);waiting.resolve();}
});
