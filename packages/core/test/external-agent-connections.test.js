import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime} from '../dist/index.js';
const token='a-very-private-remote-credential-123456';
async function setup(t,handler){
 const dir=mkdtempSync(join(tmpdir(),'remote-agent-'));
 const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),modelAdapter:{name:'fake',runTurn:async()=>({stopReason:'end',assistantParts:[]}),summarizeMessages:async()=>''}});
 const bot=runtime.createBot({name:'Sender'});const session=runtime.getSession(bot.canonicalSessionId);
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await runtime.destroy();rmSync(dir,{recursive:true,force:true});});
 const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const principal={userId:session.metadata.userId};
 const config={id:'peer',name:'Peer',enabled:true,baseUrl,token,allowedBotIds:[bot.id],target:{kind:'bot',id:'remote-worker'},allowPrivateNetwork:true};
 const ctx={session,agent:runtime.store.getAgent(bot.id)};
 return {runtime,bot,ctx,principal,config};
}
test('real delegation and query are scoped to Bot and owner [AC:external-agent-bots#AC-4]',async t=>{
 let posts=0;const d=await setup(t,async(q,r)=>{assert.equal(q.headers.authorization,'Bearer '+token);let body='';for await(const b of q)body+=b;
 if(q.method==='POST'){posts++;const v=JSON.parse(body);assert.equal(v.botId,'remote-worker');assert.equal(v.goal,'Report');r.writeHead(202).end(JSON.stringify({task:{id:'remote-1',status:'queued'}}));}
 else r.end(JSON.stringify({task:{id:'remote-1',status:'completed',result:'Done'}}));});
 const service=d.runtime.externalAgents;service.configure({connections:[d.config]},d.principal);
 const row=await service.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'one',goal:'Report'});
 assert.equal(row.status,'queued');assert.equal(row.remoteTaskId,'remote-1');
 assert.equal((await service.status(d.ctx,row.id)).task.result,'Done');
 await assert.rejects(()=>service.delegate({...d.ctx,session:{...d.ctx.session,metadata:{...d.ctx.session.metadata,botId:'other'}}},{connectionId:'peer',idempotencyKey:'two',goal:'Report'}));
 await assert.rejects(()=>service.status({...d.ctx,session:{...d.ctx.session,metadata:{...d.ctx.session.metadata,userId:'other'}}},row.id));assert.equal(posts,1);
});
test('durable parallel idempotency and lost response retry [AC:external-agent-bots#AC-5]',async t=>{
 let posts=0;const d=await setup(t,async(q,r)=>{posts++;await new Promise(r=>setTimeout(r,20));r.writeHead(202).end(JSON.stringify({task:{id:'remote-1',status:'queued'}}));});
 const service=d.runtime.externalAgents;service.configure({connections:[d.config]},d.principal);
 const args={connectionId:'peer',idempotencyKey:'same',goal:'Report'};
 const rows=await Promise.all(Array.from({length:5},()=>service.delegate(d.ctx,args)));
 assert.equal(new Set(rows.map(r=>r.id)).size,1);assert.equal(posts,1);
 const row=await service.delegate(d.ctx,args);assert.equal(row.remoteTaskId,'remote-1');assert.equal(posts,1);
 await assert.rejects(()=>service.delegate(d.ctx,{...args,goal:'Changed'}),/different/);
});
test('saved connections hide credentials and revoke captured tools [AC:external-agent-bots#AC-3] [AC:external-agent-bots#AC-6]',async t=>{
 const d=await setup(t,async(q,r)=>r.end(JSON.stringify({task:{id:'x',status:'queued',result:token}})));
 const service=d.runtime.externalAgents;service.configure({connections:[d.config]},d.principal);
 assert.equal(JSON.stringify(service.settings()).includes(token),false);
 assert.equal(service.settings().connections[0].tokenSet,true);
 const tools=service.tools();assert.ok(tools.find(t=>t.name==='external_agent_delegate'));
 service.configure({connections:[{...d.config,token:undefined,enabled:false}]},d.principal);
 const result=await tools.find(t=>t.name==='external_agent_delegate').execute(d.ctx,{connectionId:'peer',idempotencyKey:'no',goal:'Report'});
 assert.equal(result.ok,false);
 service.configure({connections:[{...d.config,allowPrivateNetwork:false}]},d.principal);
 const row=await service.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'blocked',goal:'Report'});assert.equal(row.status,'unknown');
 assert.equal(JSON.stringify(row).includes(token),false);
});

test('lost acceptance retries use the same remote identity after service recreation [AC:external-agent-bots#AC-5]',async t=>{
 const identities=[];let posts=0;
 const d=await setup(t,async(q,r)=>{let body='';for await(const b of q)body+=b;identities.push(JSON.parse(body).sourceTaskId);posts++;if(posts===1){q.socket.destroy();return;}r.end(JSON.stringify({task:{id:'recovered',status:'queued'}}));});
 d.runtime.externalAgents.configure({connections:[d.config]},d.principal);
 const args={connectionId:'peer',idempotencyKey:'lost',goal:'Report'};
 const first=await d.runtime.externalAgents.delegate(d.ctx,args);assert.equal(first.status,'unknown');assert.equal(first.remoteTaskId,undefined);
 const {ExternalAgentConnections}=await import('../dist/external-agents/connections.js');
 const recovered=new ExternalAgentConnections(d.runtime.store,(id,p)=>{d.runtime.openBot(id,p);});
 const second=await recovered.delegate(d.ctx,args);assert.equal(first.id,second.id);assert.equal(second.remoteTaskId,'recovered');assert.deepEqual(identities,[first.sourceTaskId,first.sourceTaskId]);
});

test('redirect, oversized and malformed responses do not leak credentials or claim completion [AC:external-agent-bots#AC-6]',async t=>{
 let mode='redirect',count=0;
 const d=await setup(t,async(q,r)=>{count++;if(mode==='redirect')r.writeHead(302,{location:'/elsewhere'}).end();else if(mode==='oversize')r.end('x'.repeat(1000001));else if(mode==='malformed')r.end('{invalid');else r.end(JSON.stringify({task:{id:'x',status:'completed',result:token}}));});
 d.runtime.externalAgents.configure({connections:[d.config]},d.principal);
 for(const value of ['redirect','oversize','malformed']){mode=value;const row=await d.runtime.externalAgents.delegate(d.ctx,{connectionId:'peer',idempotencyKey:value,goal:'Report'});assert.equal(row.status,'unknown');}
 assert.equal(count,3);mode='secret';const row=await d.runtime.externalAgents.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'secret',goal:'Report'});assert.equal(row.task.result,'[REDACTED]');
});

test('remote input and cancel use tracked tasks and refusals remain failures [AC:external-agent-bots#AC-6]',async t=>{
 let input=0,cancel=0;const d=await setup(t,async(q,r)=>{let body='';for await(const b of q)body+=b;
 if(q.url.endsWith('/input')){input++;assert.deepEqual(JSON.parse(body),{message:'Extra details',inputId:'input-1'});r.end(JSON.stringify({task:{id:'r',status:'running'}}));}
 else if(q.url.endsWith('/cancel')){cancel++;r.end(JSON.stringify({task:{id:'r',status:'cancelled'}}));}
 else r.end(JSON.stringify({task:{id:'r',status:'waiting_input'}}));});
 d.runtime.externalAgents.configure({connections:[d.config]},d.principal);
 const row=await d.runtime.externalAgents.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'waiting',goal:'Report'});assert.equal(row.status,'waiting_input');
 assert.equal((await d.runtime.externalAgents.action(d.ctx,{taskId:row.id,message:'Extra details',inputId:'input-1'},'input')).status,'running');
 assert.equal((await d.runtime.externalAgents.action(d.ctx,{taskId:row.id},'cancel')).status,'cancelled');assert.equal(input,1);assert.equal(cancel,1);
});

test('target edits fence old tasks; credential rotation and restoration retain tracking [AC:external-agent-bots#AC-5] [AC:external-agent-bots#AC-6]',async t=>{
 const d=await setup(t,async(q,r)=>r.end(JSON.stringify({task:{id:'r',status:'completed',result:'Done'}})));
 const svc=d.runtime.externalAgents;svc.configure({connections:[d.config]},d.principal);
 const row=await svc.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'original',goal:'Report'});
 svc.configure({connections:[{...d.config,target:{kind:'agent',id:'other'},token:undefined}]},d.principal);
 await assert.rejects(()=>svc.status(d.ctx,row.id),/target changed/);
 svc.configure({connections:[{...d.config,token:undefined}]},d.principal);
 assert.equal((await svc.status(d.ctx,row.id)).status,'completed');
 svc.configure({connections:[]},d.principal);
 await assert.rejects(()=>svc.status(d.ctx,row.id));
});

test('remote credential survives an unrelated Lab vault edit [AC:external-agent-bots#AC-3]',async t=>{
 const d=await setup(t,async(q,r)=>{assert.equal(q.headers.authorization,'Bearer '+token);r.end(JSON.stringify({task:{id:'r',status:'queued'}}));});
 d.runtime.externalAgents.configure({connections:[d.config]},d.principal);
 d.runtime.secretVault.set('UNRELATED_LAB_SECRET','another-private-value');
 const row=await d.runtime.externalAgents.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'after-secret-edit',goal:'Report'});assert.equal(row.remoteTaskId,'r');
});

test('remote credential is redacted in JSON object keys as well as values [AC:external-agent-bots#AC-6]',async t=>{
 const d=await setup(t,async(q,r)=>r.end(JSON.stringify({task:{id:'r',status:'completed',artifacts:[{[token]:token}]}})));
 d.runtime.externalAgents.configure({connections:[d.config]},d.principal);
 const row=await d.runtime.externalAgents.delegate(d.ctx,{connectionId:'peer',idempotencyKey:'key-redaction',goal:'Report'});
 assert.equal(JSON.stringify(row).includes(token),false);
});
