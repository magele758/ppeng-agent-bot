import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SoftwareExecution } from '../dist/connectors/software-execution.js';
import { parseOpenApiSpec } from '../dist/discovery/adapters/openapi.js';
const memory=()=>{const map=new Map();return {getDaemonControl:k=>structuredClone(map.get(k)),setDaemonControl:(k,v)=>map.set(k,structuredClone(v))};};
const ctx=(bot='a',user='u')=>({session:{id:'s',metadata:{botId:bot,userId:user}},agent:{id:'general'}});
async function server(fn){const s=createServer(fn);await new Promise(r=>s.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${s.address().port}`,close:()=>new Promise(r=>{s.closeAllConnections();s.close(r);})};}
const decl=(url,method='GET')=>({name:'software_test',description:'test',inputSchema:{type:'object'},executor:{kind:'http',url,method}});

test('real bound HTTP result and write idempotency [AC:bot-software-execution#AC-1] [AC:bot-software-execution#AC-5]',async()=>{
 let count=0;const s=await server((q,r)=>{count++;r.end(JSON.stringify({worked:true,auth:q.headers.authorization}));});
 try {const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1',TOKEN:'private-secret-123'});const t=decl(s.url,'POST');t.executor.auth={kind:'bearer'};e.bind(e.principal({userId:'u'}),'a','local',{tools:[t],secretEnv:'TOKEN'});
 const result=await e.execute(ctx(),'software_test',{body:{value:1},idempotency_key:'one'});assert.equal(result.ok,true);assert.match(result.content,/worked/);assert.equal(result.content.includes('private-secret-123'),false);
 await e.execute(ctx(),'software_test',{body:{value:1},idempotency_key:'one'});assert.equal(count,1);assert.equal(e.invocations()[0].state,'completed');
 }finally{await s.close();}
});
test('OpenAPI parameters JSON and local refs execute; unsupported rejected [AC:bot-software-execution#AC-2]',async()=>{
 let request;const s=await server(async(q,r)=>{let body='';for await(const b of q)body+=b;request={url:q.url,header:q.headers['x-example'],body:JSON.parse(body)};r.end('{}');});
 try{const spec={
   openapi:'3.1.0',info:{title:'local'},servers:[{url:s.url}],
   components:{schemas:{Body:{type:'object',properties:{value:{type:'number'}}}}},
   paths:{
    '/item/{id}':{post:{operationId:'update_item',
      parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'page',in:'query',schema:{type:'integer'}},{name:'X-Example',in:'header',schema:{type:'string'}}],
      requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Body'}}}},
      responses:{200:{content:{'application/json':{schema:{type:'object'}}}}}
    }},
    '/unsupported':{post:{requestBody:{content:{'image/png':{}}}}}
   }
 };
 const parsed=parseOpenApiSpec(spec);assert.equal(parsed.tools.length,1);assert.equal(parsed.unsupported.length,1);
 const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'});e.bind(e.principal({userId:'u'}),'a','api',{tools:parsed.tools});assert.equal((await e.execute(ctx(),'update_item',{id:'x y',page:2,'X-Example':'yes',body:{value:9}})).ok,true);
 assert.deepEqual(request,{url:'/item/x%20y?page=2',header:'yes',body:{value:9}});
 assert.throws(()=>parseOpenApiSpec({openapi:'2.0',paths:{}}),/unsupported/);
 }finally{await s.close();}
});
test('Bot grants credentials isolation, real probe and same-turn revoke [AC:bot-software-execution#AC-3]',async()=>{
 const s=await server((q,r)=>{r.end(q.headers.authorization??'none');});try {
 const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1',ONE:'one-private-token',TWO:'two-private-token'});const t=decl(s.url);t.executor.auth={kind:'bearer'};
 e.bind(e.principal({userId:'u'}),'a','local',{tools:[t],secretEnv:'ONE'});e.bind(e.principal({userId:'u'}),'b','local',{tools:[t],secretEnv:'TWO'});
 assert.equal((await e.probe(e.principal({userId:'u'}),'a','local')).health,'ready');
 assert.equal((await e.execute(ctx('b'),'software_test',{})).ok,true);
 assert.equal((await e.execute(ctx('a','other'),'software_test',{})).ok,false);
 const captured=e.tools()[0];e.revoke(e.principal({userId:'u'}),'a','local');assert.equal((await captured.execute(ctx(),{})).ok,false);
 }finally{await s.close();}
});
test('network policy, size limit, cancellation and write unknown [AC:bot-software-execution#AC-4] [AC:bot-software-execution#AC-5]',async()=>{
 const s=await server((q,r)=>{if(q.url==='/hang')return; r.end('x'.repeat(100));});try {
 const store=memory(),e=new SoftwareExecution(store,{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'});const t=decl(s.url+'/hang','POST');t.executor.timeoutMs=25;e.bind(e.principal({userId:'u'}),'a','local',{tools:[t]});
 const result=await e.execute(ctx(),'software_test',{idempotency_key:'timeout'});assert.equal(result.ok,false);assert.match(result.content,/unknown/);const recovered=new SoftwareExecution(store,{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'});assert.equal(recovered.invocations()[0].state,'unknown');assert.equal((await recovered.execute(ctx(),'software_test',{idempotency_key:'timeout'})).ok,false);
 const limited=decl(s.url);limited.executor.maxBytes=10;e.bind(e.principal({userId:'u'}),'a','local',{tools:[limited]});assert.match((await e.execute(ctx(),'software_test',{})).content,/size limit/);
 const denied=new SoftwareExecution(memory(),{});denied.bind(denied.principal({userId:'u'}),'a','local',{tools:[decl(s.url)]});assert.match((await denied.execute(ctx(),'software_test',{})).content,/network policy/);
 const controller=new AbortController();controller.abort();assert.match((await e.execute({...ctx(),abortSignal:controller.signal},'software_test',{})).content,/cancelled/);
 }finally{await s.close();}
});
test('MCP bound executor actually invokes and recover interrupted running [AC:bot-software-execution#AC-1] [AC:bot-software-execution#AC-5]',async()=>{
 const store=memory(),e=new SoftwareExecution(store);let calls=0;e.setMcpInvoker(async(name,args)=>{calls++;assert.equal(name,'mcp_h0_echo');return {ok:true,content:JSON.stringify(args)};});
 e.bind(e.principal({userId:'u'}),'a','mcp',{tools:[{name:'software_test',description:'echo',inputSchema:{type:'object'},executor:{kind:'mcp',toolName:'mcp_h0_echo'}}]});assert.equal((await e.execute(ctx(),'software_test',{value:'hello'})).ok,true);assert.equal(calls,1);
 const rows=e.invocations();rows[0].state='running';delete rows[0].result;store.setDaemonControl('software_invocations_v1',rows);const recovered=new SoftwareExecution(store);assert.equal(recovered.invocations()[0].state,'unknown');
});
test('bound MCP reaches real local HTTP MCP server [AC:bot-software-execution#AC-1]',async()=>{
 const { McpManager }=await import('../dist/mcp/mcp-manager.js');let calls=0;
 const s=await server(async(q,r)=>{
   if(q.method==='GET'){r.writeHead(405).end();return;}
   if(q.method==='DELETE'){r.writeHead(200).end();return;}
   let text='';for await(const b of q)text+=b;const req=JSON.parse(text);
   if(req.id===undefined){r.writeHead(202).end();return;}
   let result={};
   if(req.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'local-mcp',version:'1'}};
   if(req.method==='tools/list')result={tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
   if(req.method==='tools/call'){calls++;result={content:[{type:'text',text:'MCP:'+req.params.arguments.value}]};}
   r.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
 });
 const tools=[],manager=new McpManager({stateDir:'/tmp',tools,env:{RAW_AGENT_MCP_HTTP:JSON.stringify([{url:s.url}]),RAW_AGENT_MCP_EXPAND_HTTP:'1'},log:{warn:()=>{}}});
 try{await manager.ensureLoaded('s');const e=new SoftwareExecution(memory());e.setMcpInvoker((name,args,c)=>tools.find(t=>t.name===name).execute(c,args));e.bind(e.principal({userId:'u'}),'a','mcp',{tools:[{name:'software_test',description:'echo',inputSchema:{type:'object'},executor:{kind:'mcp',toolName:'mcp_h0_echo',readOnly:true}}]});const out=await e.execute(ctx(),'software_test',{value:'hello'});assert.equal(out.ok,true);assert.match(out.content,/MCP:hello/);assert.equal(calls,1);}finally{await manager.destroy();await s.close();}
});
test('same tool name never hides write approval across Bot bindings [AC:bot-software-execution#AC-3]',()=>{
 const e=new SoftwareExecution(memory());e.bind(e.principal({userId:'u'}),'a','read',{tools:[decl('https://example.com','GET')]});e.bind(e.principal({userId:'u'}),'b','write',{tools:[decl('https://example.com','POST')]});assert.equal(e.tools()[0].needsApproval(ctx('b'),{}),true);
});
test('unknown write cannot retry with a new key; explicit reconciliation is scoped [AC:bot-software-execution#AC-5]',async()=>{
 let calls=0;const s=await server((q,r)=>{calls++;r.writeHead(500).end('uncertain write');});try{
 const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'}),principal=e.principal({userId:'u'});e.bind(principal,'a','local',{tools:[decl(s.url,'POST')]});
 await e.execute(ctx(),'software_test',{body:{value:1},idempotency_key:'first'});const id=e.invocations()[0].id;
 await e.execute(ctx(),'software_test',{body:{value:1},idempotency_key:'changed'});assert.equal(calls,1);
 assert.throws(()=>e.resolveInvocation(e.principal({userId:'other'}),'a','local',id,'failed','checked'),/unknown/);
 const row=e.resolveInvocation(principal,'a','local',id,'failed','verified no write occurred');assert.equal(row.state,'failed');
 await e.execute(ctx(),'software_test',{body:{value:1},idempotency_key:'changed'});assert.equal(calls,2);
 }finally{await s.close();}
});
test('HTTP redirect respects same-origin and never forwards credentials to another origin [AC:bot-software-execution#AC-4]',async()=>{
 let stolen=false;const target=await server((q,r)=>{stolen=true;r.end('unexpected');});
 const origin=await server((q,r)=>{r.writeHead(302,{location:target.url}).end();});try{
 const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1',TOKEN:'secret-redirect-token'});const t=decl(origin.url);t.executor.auth={kind:'bearer'};e.bind(e.principal({userId:'u'}),'a','local',{tools:[t],secretEnv:'TOKEN'});
 const out=await e.execute(ctx(),'software_test',{});assert.equal(out.ok,false);assert.match(out.content,/redirect refused/);assert.equal(stolen,false);
 }finally{await origin.close();await target.close();}
});
test('declarative plugin loads executor and Bot binding executes real software [AC:bot-software-execution#AC-1]',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {loadPluginFromDir}=await import('../dist/plugins/plugin-loader.js');const {createConnectorRegistry}=await import('../dist/connectors/registry.js');
 const dir=mkdtempSync(join(tmpdir(),'software-plugin-')),s=await server((q,r)=>r.end('{"pluginWorked":true}'));
 const prior=process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE='1';
 try{writeFileSync(join(dir,'plugin.json'),JSON.stringify({id:'real',name:'real',tools:[decl(s.url)]}));const plugin=loadPluginFromDir(dir);const registry=createConnectorRegistry({store:memory(),getPlugins:()=>[plugin]});
 registry.bindSoftware(registry.software.principal({userId:'u'}),'a','plugin:real',{});const tool=registry.toolsForGranted().find(t=>t.name==='software_test');assert.equal((await tool.execute(ctx(),{})).ok,true);
 }finally{if(prior===undefined)delete process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;else process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE=prior;rmSync(dir,{recursive:true,force:true});await s.close();}
});
test('Lab vault credential reference is resolved only for bound Bot and redacted [AC:bot-software-execution#AC-3]',async()=>{
 const {SecretVault}=await import('../dist/secrets/secret-vault.js');const store=memory(),vault=new SecretVault(store);vault.set('SOFTWARE_VAULT_TOKEN','vault-private-credential');let auth;
 const s=await server((q,r)=>{auth=q.headers.authorization;r.end(auth);});try{const e=new SoftwareExecution(store,{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'});const t=decl(s.url);t.executor.auth={kind:'bearer'};e.bind(e.principal({userId:'u'}),'a','vault',{tools:[t],credRef:'vault:SOFTWARE_VAULT_TOKEN'});const result=await e.execute(ctx(),'software_test',{});assert.equal(result.ok,true);assert.equal(auth,'Bearer vault-private-credential');assert.equal(result.content.includes('vault-private-credential'),false);}finally{await s.close();}
});
test('running attempts survive real SQLite reopen as unknown [AC:bot-software-execution#AC-5]',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {SqliteStateStore}=await import('../dist/storage.js');
 const dir=mkdtempSync(join(tmpdir(),'software-restart-'));let first,second;
 try{first=new SqliteStateStore(join(dir,'state.sqlite'));const e=new SoftwareExecution(first);let enter;const entered=new Promise(r=>enter=r);e.setMcpInvoker(async()=>{enter();return new Promise(()=>{});});e.bind(e.principal({userId:'u'}),'a','mcp',{tools:[{name:'software_test',description:'write',inputSchema:{type:'object'},executor:{kind:'mcp',toolName:'mcp_h0_write'}}]});void e.execute(ctx(),'software_test',{value:1});await entered;assert.equal(e.invocations()[0].state,'running');first.db.close();first=undefined;
 second=new SqliteStateStore(join(dir,'state.sqlite'));const recovered=new SoftwareExecution(second);assert.equal(recovered.invocations()[0].state,'unknown');assert.equal(recovered.list(recovered.principal({userId:'u'}),'a').length,1);assert.match((await recovered.execute(ctx(),'software_test',{value:1})).content,/unknown/);
 }finally{first?.db.close();second?.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('indexed ledger preserves old unknown after more than 10k invocations and paginates without overlap [AC:bot-software-execution#AC-5]',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {SqliteStateStore}=await import('../dist/storage.js');
 const dir=mkdtempSync(join(tmpdir(),'software-scale-'));let store;
 try{store=new SqliteStateStore(join(dir,'state.sqlite'));const e=new SoftwareExecution(store);assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='software_invocations'").get());const principal=e.principal({userId:'u'});let calls=0;
 e.setMcpInvoker(async(_,args)=>{calls++;return {ok:args.operation!=='uncertain',content:args.operation==='uncertain'?'unconfirmed write':'ok'};});e.bind(principal,'a','mcp',{tools:[{name:'software_test',description:'write',inputSchema:{type:'object'},executor:{kind:'mcp',toolName:'mcp_h0_write'}}]});
 await e.execute(ctx(),'software_test',{operation:'uncertain',idempotency_key:'old-unknown'});const original=e.invocations()[0];assert.equal(original.state,'unknown');
 for(let i=0;i<10010;i++)await e.execute(ctx(),'software_test',{operation:'known',value:i,idempotency_key:'known-'+i});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM software_invocations').get().n,10011);assert.deepEqual(store.getDaemonControl('software_invocations_v1'),[]);
 const newest=e.invocations(principal,'a','mcp',{limit:75}),next=e.invocations(principal,'a','mcp',{limit:75,beforeSeq:newest.at(-1).seq});assert.equal(newest.length,75);assert.equal(next.length,75);assert.equal(new Set([...newest,...next].map(r=>r.id)).size,150);
 const before=calls;assert.match((await e.execute(ctx(),'software_test',{operation:'uncertain',idempotency_key:'different-key'})).content,/unknown/);assert.equal(calls,before);assert.equal(e.resolveInvocation(principal,'a','mcp',original.id,'failed','verified no external effect').state,'failed');
 const queryPlan=store.db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM software_invocations WHERE request_hash=? AND state IN ('running','unknown') AND write_effect=1").all('hash');assert.ok(queryPlan.some(row=>row.detail.includes('software_invocations_request')));
 }finally{store?.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy KV invocation migration is complete and idempotent [AC:bot-software-execution#AC-5]',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {SqliteStateStore}=await import('../dist/storage.js');const dir=mkdtempSync(join(tmpdir(),'software-migrate-'));let store;
 try{store=new SqliteStateStore(join(dir,'state.sqlite'));store.setDaemonControl('software_invocations_v1',[{id:'legacy-unknown',principal:'owner',botId:'a',connectorId:'local',toolName:'write',fingerprint:'fingerprint-one',requestHash:'hash-one',state:'unknown',write:true,startedAt:'2026-10-13T00:00:00.000Z'},{id:'legacy-running',principal:'owner',botId:'a',connectorId:'local',toolName:'write',fingerprint:'fingerprint-two',requestHash:'hash-two',state:'running',write:true,startedAt:'2026-10-13T00:00:01.000Z'}]);
 const e=new SoftwareExecution(store);assert.equal(e.invocations('owner','a','local').length,2);assert.equal(e.invocations('owner','a','local').every(r=>r.state==='unknown'),true);new SoftwareExecution(store);assert.equal(store.db.prepare('SELECT count(*) AS n FROM software_invocations').get().n,2);assert.deepEqual(store.getDaemonControl('software_invocations_v1'),[]);
 }finally{store?.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('MCP cancellation stops waiting without claiming rollback or replaying effects [AC:bot-software-execution#AC-4] [AC:bot-software-execution#AC-5]',async()=>{
 const e=new SoftwareExecution(memory()),controller=new AbortController();let release,calls=0;e.setMcpInvoker(async()=>{calls++;return new Promise(r=>release=r);});e.bind(e.principal({userId:'u'}),'a','mcp',{tools:[{name:'software_test',description:'write',inputSchema:{type:'object'},executor:{kind:'mcp',toolName:'mcp_h0_write'}}]});
 const pending=e.execute({...ctx(),abortSignal:controller.signal},'software_test',{value:1});controller.abort();const out=await pending;assert.equal(out.ok,false);assert.match(out.content,/unknown/);release({ok:true,content:'late result'});await Promise.resolve();assert.equal(e.invocations()[0].state,'unknown');assert.match((await e.execute(ctx(),'software_test',{value:1})).content,/unknown/);assert.equal(calls,1);
});
test('late health probe cannot resurrect revoked connection [AC:bot-software-execution#AC-3]',async()=>{
 let enter,release;const entered=new Promise(r=>enter=r);const s=await server((q,r)=>{release=()=>r.writeHead(200).end();enter();});try{
 const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'}),principal=e.principal({userId:'u'});e.bind(principal,'a','local',{tools:[decl(s.url)]});const probing=e.probe(principal,'a','local');await entered;e.revoke(principal,'a','local');release();await assert.rejects(probing,/changed or revoked/);assert.equal(e.list(principal,'a').length,0);
 }finally{await s.close();}
});
test('late health probe cannot overwrite a new binding revision [AC:bot-software-execution#AC-3]',async()=>{
 let enter,release;const entered=new Promise(r=>enter=r);const s=await server((q,r)=>{release=()=>r.writeHead(200).end();enter();});try{
 const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1'}),principal=e.principal({userId:'u'});e.bind(principal,'a','local',{tools:[decl(s.url)]});const probing=e.probe(principal,'a','local');await entered;const replacement=e.bind(principal,'a','local',{tools:[decl(s.url+'/replacement')]});release();await assert.rejects(probing,/changed or revoked/);const saved=e.list(principal,'a')[0];assert.equal(saved.revision,replacement.revision);assert.equal(saved.health,'configured');assert.equal(saved.tools[0].executor.url,s.url+'/replacement');assert.equal(saved.lastProbeAt,undefined);
 }finally{await s.close();}
});
test('binding validation rejects unsafe or ambiguous software configuration [AC:bot-software-execution#AC-3] [AC:bot-software-execution#AC-4]',()=>{
 const make=()=>new SoftwareExecution(memory());const http=decl('https://example.com');
 const bodies=[{tools:[]},{tools:[{...http,name:'bash'}]},{tools:[{...http,name:'mcp_h0_collision'}]},{tools:[http,http]},{tools:[{...http,executor:{kind:'unknown'}}]},
 {tools:[decl('file:///tmp/data')]},{tools:[decl('https://user:pass@example.com')]},{tools:[decl('https://example.com','CONNECT')]},
 {tools:[{...http,executor:{...http.executor,timeoutMs:0}}]},{tools:[{...http,executor:{...http.executor,maxBytes:2000001}}]},
 {tools:[{...http,executor:{kind:'mcp',toolName:'unbound'}}]},
 {tools:[{...http,executor:{kind:'mcp',toolName:'mcp_h0_echo'}}],secretEnv:'MY_TOKEN'},
 {tools:[http],secretEnv:'NODE_OPTIONS'}, {tools:[http],secretEnv:'RAW_AGENT_AUTH_TOKEN'}];
 for(const [index,body] of bodies.entries()){const e=make();assert.throws(()=>e.bind(e.principal({userId:'u'}),'a','invalid',structuredClone(body)),`invalid binding case ${index}`);}
 const e=make(),p=e.principal({userId:'u'});e.bind(p,'a','first',{tools:[http]});assert.throws(()=>e.bind(p,'a','second',{tools:[http]}),/already bound/);assert.throws(()=>e.bind(p,'b','other',{tools:[{...http,inputSchema:{type:'object',properties:{x:{type:'number'}}}}]}),/same input schema/);
});
test('input validation and idempotency conflicts never dispatch an invalid call [AC:bot-software-execution#AC-2] [AC:bot-software-execution#AC-5]',async()=>{
 const e=new SoftwareExecution(memory());let calls=0;e.setMcpInvoker(async()=>{calls++;return {ok:true,content:'ok'};});const p=e.principal({userId:'u'});e.bind(p,'a','mcp',{tools:[{name:'typed_call',description:'typed input',inputSchema:{type:'object',properties:{items:{type:'array'},count:{type:'integer'},value:{type:'number'},enabled:{type:'boolean'},body:{type:'object'}},required:['items']},executor:{kind:'mcp',toolName:'mcp_h0_echo'}}]});
 assert.match((await e.execute(ctx(),'typed_call',{})).content,/Missing required/);assert.match((await e.execute(ctx(),'typed_call',{items:[],count:1.5})).content,/Invalid input/);assert.equal(calls,0);
 const args={items:[1],count:2,value:3,enabled:true,body:{x:1},idempotency_key:'stable'};assert.equal((await e.execute(ctx(),'typed_call',args)).ok,true);assert.match((await e.execute(ctx(),'typed_call',{...args,value:4})).content,/different arguments/);assert.equal(calls,1);
});
test('operator credentials cannot leave through new or persisted software bindings [AC:bot-software-execution#AC-3] [AC:bot-software-execution#AC-4]',async()=>{
 let requests=0;const received=[];const s=await server((q,r)=>{requests++;received.push(q.headers.authorization);r.end('ok');});
 try{
  for(const name of ['RAW_AGENT_AUTH_TOKEN','RAW_AGENT_HUMAN_RELEASE_SECRET']){
   for(const field of ['secretEnv','credRef']){
    const store=memory(),e=new SoftwareExecution(store,{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1',[name]:'operator-private-token'}),p=e.principal({userId:'u'});
    const tool=decl(s.url);tool.executor.auth={kind:'bearer'};const credential=field==='credRef'?'vault:'+name:name;
    assert.throws(()=>e.bind(p,'a','operator',{tools:[tool],[field]:credential}),/Operator credential/);
    e.bind(p,'a','persisted',{tools:[tool]});const rows=store.getDaemonControl('software_connections_v1');Object.values(rows)[0][field]=credential;store.setDaemonControl('software_connections_v1',rows);
    const result=await e.execute(ctx(),'software_test',{});assert.equal(result.ok,false);assert.match(result.content,/Operator credential/);
    assert.equal((await e.probe(p,'a','persisted')).health,'unavailable');
   }
  }
  assert.equal(requests,0);assert.deepEqual(received,[]);
  const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1',SOFTWARE_API_TOKEN:'normal-software-token'}),tool=decl(s.url);tool.executor.auth={kind:'bearer'};e.bind(e.principal({userId:'u'}),'a','normal',{tools:[tool],secretEnv:'SOFTWARE_API_TOKEN'});assert.equal((await e.execute(ctx(),'software_test',{})).ok,true);assert.equal(requests,1);assert.deepEqual(received,['Bearer normal-software-token']);
 }finally{await s.close();}
});
test('query and JSON-escaped credential echoes never reach model or invocation history [AC:bot-software-execution#AC-4]',async()=>{const s=await server((q,r)=>r.end(q.url));try{const e=new SoftwareExecution(memory(),{RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE:'1',ENCODED_TOKEN:'secret+with/slash'});const t=decl(s.url);t.executor.auth={kind:'query',name:'api_key'};e.bind(e.principal({userId:'u'}),'a','encoded',{tools:[t],secretEnv:'ENCODED_TOKEN'});const result=await e.execute(ctx(),'software_test',{});assert.equal(result.ok,true);assert.equal(result.content.includes('secret%2Bwith%2Fslash'),false);assert.equal(JSON.stringify(e.invocations()).includes('secret%2Bwith%2Fslash'),false);}finally{await s.close();}});
