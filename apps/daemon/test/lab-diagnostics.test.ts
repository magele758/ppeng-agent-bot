import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionListSummary, sessionSummaryEtag } from '../dist/session-list-summary.js';
import { createClientErrorWriter } from '../dist/client-errors.js';

test('lightweight list excludes large private runtime fields without modifying detail [AC:lab-poll-crash-diagnostics#AC-1]', () => {
 const session = {id:'s1',title:'Bot',status:'running',mode:'chat',agentId:'general',metadata:{botId:'b1',parentSessionId:'parent',spawnSource:'concurrent-bot-work',sourceMessageId:'m1',eventLog:'x'.repeat(2_000_000),stepCheckpoints:['large'],futureInternal:{secret:'private'}},summary:'long'.repeat(10000),todo:['large']};
 const summary=sessionListSummary(session);
 assert.equal(summary.metadata.botId,'b1');assert.equal(summary.metadata.sourceMessageId,'m1');
 assert.equal(summary.metadata.eventLog,undefined);assert.equal(summary.metadata.futureInternal,undefined);
 assert.ok(JSON.stringify(summary).length<5000);assert.equal(session.metadata.eventLog.length,2_000_000);
});
test('summary cache changes only with visible snapshot [AC:lab-poll-crash-diagnostics#AC-2]',()=>{
 const first={id:'s',status:'idle',metadata:{eventLog:['a']}};
 assert.equal(sessionSummaryEtag([sessionListSummary(first)]),sessionSummaryEtag([sessionListSummary({...first,metadata:{eventLog:['b']}})]));
 assert.notEqual(sessionSummaryEtag([sessionListSummary(first)]),sessionSummaryEtag([sessionListSummary({...first,status:'running'})]));
});
test('client diagnostics persist bounded records and rotate [AC:lab-poll-crash-diagnostics#AC-3] [AC:lab-poll-crash-diagnostics#AC-4]',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'client-errors-'));
 try {
 const write=createClientErrorWriter(dir,500);
 await write({kind:'error',message:'failure',stack:'at render (app.js:1:2)',page:'/chat?secret=hidden',sessionId:'s1',buildId:'build-a',userAgent:'test',conversation:'DO NOT LOG'});
 const file=join(dir,'logs/client-errors.jsonl');
 const row=JSON.parse((await readFile(file,'utf8')).trim());
 assert.equal(row.stack,'at render (app.js:1:2)');assert.equal(row.sessionId,'s1');assert.equal(row.buildId,'build-a');assert.ok(row.receivedAt);
 assert.equal(row.page,'/chat');assert.equal(row.conversation,undefined);
 for(let i=0;i<5;i++)await write({kind:'error',message:'x'.repeat(1000)});
 assert.ok((await readFile(file)).length<17000);assert.ok((await readFile(file+'.1')).length>0);
 await assert.rejects(write(null));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('summary route keeps filtering, scoped cache and full-detail compatibility [AC:lab-poll-crash-diagnostics#AC-1] [AC:lab-poll-crash-diagnostics#AC-2]',async()=>{
 const {sessionsRoutes}=await import('../dist/routes/sessions.js');
 const records=[{id:'s1',title:'one',status:'idle',metadata:{userId:'a',eventLog:'secret-log'}},{id:'s2',title:'two',status:'idle',metadata:{userId:'b'}}];
 const runtime={listSessions:()=>records,getStateVersion:()=>1};
 const route=sessionsRoutes(runtime).find(r=>r.method==='GET'&&r.pattern==='/api/sessions');
 assert.ok(route);
 const call=async(query:string,etag?:string,user='a')=>{
  const headers:Record<string,string>={};let body='';
  const response={statusCode:200,setHeader:(k:string,v:string)=>{headers[k]=v;},end:(v='')=>{body=v;}};
  await route.handler({request:{headers:{'if-none-match':etag}},response,url:new URL('http://local/api/sessions'+query),auth:{isolate:true,user:{id:user}}});
  return {status:response.statusCode,headers,body};
 };
 const first=await call('?view=summary');assert.deepEqual(JSON.parse(first.body).sessions.map(s=>s.id),['s1']);assert.ok(!first.body.includes('secret-log'));
 assert.equal((await call('?view=summary',first.headers.etag)).status,304);
 assert.equal((await call('?view=summary',first.headers.etag,'b')).status,200);
 assert.equal(JSON.parse((await call('?view=summary&q=missing')).body).sessions.length,0);
 assert.ok((await call('')).body.includes('secret-log'));
});

test('diagnostic endpoint accepts a browser report over HTTP [AC:lab-poll-crash-diagnostics#AC-3]',async()=>{
 const {createServer}=await import('node:http');const {Router}=await import('../dist/routing.js');
 const {clientErrorRoutes}=await import('../dist/routes/client-errors.js');
 const dir=await mkdtemp(join(tmpdir(),'client-error-http-'));
 const router=new Router({policy:new Map([['POST /api/client-errors',{kind:'authenticated'}]]),readBody:async request=>{let body='';for await(const chunk of request)body+=chunk;return JSON.parse(body);}}).addAll(clientErrorRoutes({stateDir:dir}));
 const server=createServer((req,res)=>{void router.dispatch(req,res,new URL(req.url!,'http://local'));});
 try {
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/client-errors`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'react',message:'HTTP probe',stack:'at render',componentStack:'at ChatTurns',sessionId:'s'})});
  assert.equal(response.status,202);assert.match(await readFile(join(dir,'logs/client-errors.jsonl'),'utf8'),/ChatTurns/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
