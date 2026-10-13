import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {loadSqlDump} from '../../migration-fixtures/sql-dump.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AuthStore,hashToken,RawAgentRuntime} from '@ppeng/agent-core';
import {createDaemonApp} from '../../../apps/daemon/dist/app.js';
export async function boot(legacy=false,options={}){
 const repoRoot=options.repoRoot??mkdtempSync(join(tmpdir(),'identity-http-repo-')),stateDir=options.stateDir??mkdtempSync(join(tmpdir(),'identity-http-state-'));
 if(legacy){const raw=new DatabaseSync(join(stateDir,'runtime.sqlite'));loadSqlDump(raw,readFileSync(new URL('../../migration-fixtures/snapshots/v24.sql',import.meta.url),'utf8'));raw.prepare("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.userId','alice','$.tenantId','tenant') WHERE id=(SELECT canonical_session_id FROM bots WHERE id='researcher')").run();raw.close();}
 const runtime=new RawAgentRuntime({repoRoot,stateDir,modelAdapter:options.modelAdapter??{name:'idle',async runTurn(){return {stopReason:'end',assistantParts:[{type:'text',text:'ok'}]};},async summarizeMessages(){return ''}},...(options.extraTools?{extraTools:options.extraTools}:{})});
 const authStore=new AuthStore(runtime.store.db),env={RAW_AGENT_OAUTH_GITHUB_CLIENT_ID:'test',RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET:'test-secret'};
 const app=createDaemonApp({runtime,authStore,env,repoRoot,config:{storageCtx:{},domainsMounted:[]},pkgName:'test',pkgVersion:'0',readBody:async req=>{let body='';for await(const part of req)body+=part;return body?JSON.parse(body):{};},readBodyLimit:2000000,gateway:()=>undefined});
 const server=createServer(async(req,res)=>{try{if(!await app.handle(req,res)){res.statusCode=404;res.end('{}');}}catch(e){res.statusCode=e.statusCode??500;res.end(JSON.stringify({error:e.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const tokens={};const memory=runtime.store.agentMemory();memory.upsertTenant({id:'tenant',name:'Tenant',createdAt:new Date().toISOString()});
 for(const id of ['alice','bob']){memory.upsertUser({id,email:id+'@example.test',status:'active',createdAt:new Date().toISOString()});memory.addMembership({userId:id,tenantId:'tenant',role:'member'});tokens[id]=randomBytes(16).toString('hex');authStore.createAuthSession({tokenHash:hashToken(tokens[id]),userId:id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});}
 const call=async(id,method,path,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method,headers:{'content-type':'application/json','x-ppeng-lab':'1',cookie:`ppeng_lab_session=${tokens[id]}`},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 return {runtime,call,url:`http://127.0.0.1:${server.address().port}`,headers:{'content-type':'application/json','x-ppeng-lab':'1',cookie:`ppeng_lab_session=${tokens.alice}`},close:async()=>{await new Promise(resolve=>server.close(resolve));await runtime.destroy();}};
}
