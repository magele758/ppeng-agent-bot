import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTools } from '../dist/tools/memory-tools.js';
import { compileTurnAppendix } from '../dist/session/context-compiler.js';
import { collectSubagentMemoryHits } from '../dist/memory/subagent-recall.js';
import { workingLogPath } from '../dist/session/working-log.js';

const BEFORE = '2026-01-01T00:00:00.000Z';
const DURING = '2026-01-02T12:00:00.000Z';
const AFTER = '2026-01-04T00:00:00.000Z';
const window = { revoked: [{fromSeq:3,toSeq:8,startedAt:'2026-01-02T00:00:00.000Z',endedAt:'2026-01-03T00:00:00.000Z'}] };
function fixture() {
 const parent={id:'parent',agentId:'bot-a',mode:'chat',metadata:{userId:'u',botId:'bot-a'}};
 const child={id:'child',agentId:'reviewer',mode:'subagent',parentSessionId:parent.id,metadata:{userId:'u'}};
 const row=(id,time,value,extra={})=>({id,scope:'user.memory',namespace:'semantic',key:`fact:${id}`,value:`beacon ${value}`,
   sessionId:parent.id,userId:'u',agentId:'bot-a',importance:1,confidence:'high',createdAt:time,updatedAt:time,accessCount:0,...extra});
 const privateRow=row('private',BEFORE,'PRE_PRIVATE');
 const derived=row('derived',DURING,'OLD_GROUP_SECRET');
 const carried=row('carried',AFTER,'COPIED_OLD_GROUP_SECRET',{sessionId:child.id,sourceRefs:[{sessionId:parent.id,messageId:'m4',seq:4}]});
 const rows=[derived,carried,privateRow];
 const legacy=[{id:'legacy-old',scope:'scratch',key:'beacon.old',value:'beacon LEGACY_OLD_GROUP_SECRET',updatedAt:DURING},
   {id:'legacy-private',scope:'scratch',key:'beacon.private',value:'beacon PRE_PRIVATE',updatedAt:BEFORE}];
 const lookup={getBot:id=>id==='bot-a'?{id,agentId:id}:undefined,listBots:()=>[{id:'bot-a',agentId:'bot-a'}],
   getSession:id=>id===parent.id?parent:id===child.id?child:undefined,
   getDaemonControl:key=>key===`bot.sharedExposure:${parent.id}`?window:undefined};
 const am={search:filter=>rows.filter(row=>(!filter.scope||row.scope===filter.scope)),getUserProfile:()=>undefined,getEmbedding:()=>undefined};
 return {parent,child,rows,legacy,lookup,am};
}

test('memory get/search/read/prefetch revoke derived memories including known refs but preserve earlier private facts [AC:bot-functional-groups#AC-9]',async()=>{
 const f=fixture();
 const tools=createMemoryTools({botLookup:f.lookup,listSessionMemory:async()=>[],listAgentMemory:async()=>f.rows,
   getAgentMemoryById:async id=>f.rows.find(row=>row.id===id),prefetchAgentMemory:async()=>f.rows});
 const run=(name,args)=>tools.find(tool=>tool.name===name).execute({session:f.parent},args);
 for(const [name,args] of [['memory_get',{scope:'user'}],['memory_search',{query:'beacon',scope:'user'}],['memory_prefetch',{}]]) {
   const result=await run(name,args);
   assert.ok(!result.content.includes('OLD_GROUP_SECRET'),`${name} must remove revoked facts`);
   assert.ok(result.content.includes('PRE_PRIVATE'),`${name} preserves pre-exposure private memory`);
 }
 for(const id of ['derived','carried']) assert.equal((await run('memory_read',{ref:`memory:user:${id}`})).ok,false,'known revoked ref cannot bypass search filtering');
 assert.equal((await run('memory_read',{ref:'memory:user:private'})).ok,true);
});

test('legacy session notes cannot resurrect revoked group facts through memory tools [AC:bot-functional-groups#AC-9]',async()=>{
 const f=fixture();
 const tools=createMemoryTools({botLookup:f.lookup,listSessionMemory:async()=>f.legacy});
 const run=(name,args)=>tools.find(tool=>tool.name===name).execute({session:f.parent},args);
 for(const [name,args] of [['memory_get',{}],['memory_search',{query:'beacon',scope:'scratch'}],['memory_prefetch',{}]]) {
   const result=await run(name,args);
   assert.ok(!result.content.includes('LEGACY_OLD_GROUP_SECRET'),`${name} must remove revoked legacy notes`);
   assert.ok(result.content.includes('PRE_PRIVATE'));
 }
 assert.equal((await run('memory_read',{ref:'memory:scratch:legacy-old'})).ok,false);
 assert.equal((await run('memory_read',{ref:'memory:scratch:legacy-private'})).ok,true);
});

test('context compiler hides derived memory, legacy notes and contaminated working logs after move [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture(),stateDir=mkdtempSync(join(tmpdir(),'shared-memory-isolation-'));
 const log=workingLogPath(stateDir,f.parent.id);
 mkdirSync(join(stateDir,'working-logs',f.parent.id),{recursive:true});
 writeFileSync(log,'beacon OLD_GROUP_SECRET_LOG');
 try {
   const compiled=compileTurnAppendix({session:f.parent,query:'beacon',stateDir,store:{...f.lookup,agentMemory:()=>f.am}});
   assert.ok(!compiled.includes('OLD_GROUP_SECRET'));
   assert.ok(compiled.includes('PRE_PRIVATE'));
   const legacy=compileTurnAppendix({session:f.parent,query:'beacon',store:{...f.lookup,listSessionMemory:()=>f.legacy}});
   assert.ok(!legacy.includes('LEGACY_OLD_GROUP_SECRET'));
   assert.ok(legacy.includes('PRE_PRIVATE'));
   const backend=process.env.RAW_AGENT_MEMORY_BACKEND;
   try {
     process.env.RAW_AGENT_MEMORY_BACKEND='session';
     const legacyWithAgentStore=compileTurnAppendix({session:f.parent,query:'beacon',
       store:{...f.lookup,agentMemory:()=>f.am,listSessionMemory:()=>f.legacy}});
     assert.ok(!legacyWithAgentStore.includes('OLD_GROUP_SECRET'));
     assert.ok(legacyWithAgentStore.includes('PRE_PRIVATE'));
   } finally {
     if(backend===undefined)delete process.env.RAW_AGENT_MEMORY_BACKEND;
     else process.env.RAW_AGENT_MEMORY_BACKEND=backend;
   }
 } finally {rmSync(stateDir,{recursive:true,force:true});}
});

test('subagent parent and durable recall reject revoked exposures while preserving earlier private memory [AC:bot-functional-groups#AC-9]',()=>{
 const f=fixture();
 const hits=collectSubagentMemoryHits({...f.lookup,listSessionMemory:(_id,scope)=>scope==='scratch'?f.legacy:[],agentMemory:()=>f.am},f.child,'beacon');
 assert.ok(!JSON.stringify(hits).includes('OLD_GROUP_SECRET'));
 assert.ok(hits.some(hit=>hit.origin==='parent'&&hit.excerpt.includes('PRE_PRIVATE')));
 assert.ok(hits.some(hit=>hit.origin==='global'&&hit.excerpt.includes('PRE_PRIVATE')));
});
