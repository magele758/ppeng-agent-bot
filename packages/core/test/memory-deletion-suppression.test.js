import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { saveSemanticFact } from '../dist/memory/memory-writer.js';
import { memoryRoutes } from '../../../apps/daemon/dist/routes/memory.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'memory-suppression-'));
 let store=new SqliteStateStore(join(dir,'db'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 return {get store(){return store;},get am(){return store.agentMemory();}, reopen(){store.db.close();store=new SqliteStateStore(join(dir,'db'));}};
}
const fact={scope:'user.memory',namespace:'semantic',key:'preference:style',value:'用户偏好简洁回答',userId:'u1',tenantId:'t1',agentId:'b1',importance:0.8,confidence:'high'};
const learn=(am,content=fact.value,extra={})=>saveSemanticFact(am,{userId:'u1',tenantId:'t1',agentId:'b1',category:'preference',content,...extra});
async function route(f,method,pattern,{userId='u1',id,query=''}={}){
 const spec=memoryRoutes({store:f.store}).find(r=>r.method===method&&r.pattern===pattern);
 assert.ok(spec,`missing ${pattern}`);
 let payload;
 await spec.handler({auth:{isolate:true,user:{id:userId,tenantId:'t1'}},url:new URL('http://localhost'+pattern+query),requireParam:()=>id,readBody:async()=>({}),response:{setHeader(){},end(s){payload=JSON.parse(s);}}});
 return payload;
}
test('deletion removes recall and exposes suppression [AC:memory-deletion-suppression#AC-1]',async t=>{
 const f=fixture(t),m=f.am.set(fact); f.am.putEmbedding(m.id,[1,0]);
 await route(f,'DELETE','/api/memory/:id',{id:m.id});
 assert.equal(f.am.getEntryById(m.id),null);assert.equal(f.am.getEmbedding(m.id),null);
 const data=await route(f,'GET','/api/memory/suppressions');assert.equal(data.suppressions[0].memory.value,fact.value);
 assert.equal(f.am.search({userId:'u1',query:'简洁'}).length,0);
});
test('automatic learning rejects normalized and synonymous facts with reason [AC:memory-deletion-suppression#AC-2]',t=>{
 const f=fixture(t);f.am.deleteAndSuppress(f.am.set(fact).id);
 for(const text of ['用户 偏好 简洁回答。','用户喜欢简短回答'])assert.equal(learn(f.am,text),null);
 const row=f.am.listSuppressions()[0];assert.ok(row.blockedCount>=2);assert.equal(row.reason,'user_deleted');
 assert.ok(learn(f.am,'用户喜欢详细回答'));
});
test('in-flight extraction cannot resurrect a deleted fact [AC:memory-deletion-suppression#AC-3]',async t=>{
 const f=fixture(t);const id=f.am.set(fact).id;
 let release;const pending=new Promise(r=>release=r).then(()=>learn(f.am));
 f.am.deleteAndSuppress(id);release();assert.equal(await pending,null);assert.equal(f.am.search({agentId:'b1'}).length,0);
});
test('suppression persists across restart [AC:memory-deletion-suppression#AC-4]',t=>{
 const f=fixture(t);f.am.deleteAndSuppress(f.am.set(fact).id);f.reopen();assert.equal(learn(f.am),null);assert.equal(f.am.listSuppressions().length,1);
});
test('suppression preserves unrelated facts and identity boundaries [AC:memory-deletion-suppression#AC-5]',t=>{
 const f=fixture(t);f.am.deleteAndSuppress(f.am.set(fact).id);
 for(const [content,extra] of [['用户喜欢咖啡',{}],[fact.value,{agentId:'b2'}],[fact.value,{userId:'u2'}],[fact.value,{tenantId:'t2'}]])assert.ok(learn(f.am,content,extra));
 assert.equal(learn(f.am),null);
});
test('explicit restore only releases that suppression [AC:memory-deletion-suppression#AC-6]',async t=>{
 const f=fixture(t);f.am.deleteAndSuppress(f.am.set(fact).id);f.am.deleteAndSuppress(f.am.set({...fact,key:'coffee',value:'用户喜欢咖啡'}).id);
 const id=f.am.listSuppressions().find(s=>s.memory.value===fact.value).id;
 const data=await route(f,'POST','/api/memory/suppressions/:id/restore',{id});assert.equal(data.entry.value,fact.value);
 assert.equal(f.am.listSuppressions().length,1);assert.equal(learn(f.am,'用户喜欢咖啡'),null);f.reopen();assert.ok(learn(f.am));
});
test('foreign users cannot inspect delete or restore facts [AC:memory-deletion-suppression#AC-7]',async t=>{
 const f=fixture(t);const m=f.am.set(fact);
 await assert.rejects(route(f,'DELETE','/api/memory/:id',{id:m.id,userId:'u2'}));assert.ok(f.am.getEntryById(m.id));
 f.am.deleteAndSuppress(m.id);const id=f.am.listSuppressions()[0].id;
 const data=await route(f,'GET','/api/memory/suppressions',{userId:'u2'});assert.deepEqual(data.suppressions,[]);
 await assert.rejects(route(f,'POST','/api/memory/suppressions/:id/restore',{id,userId:'u2'}));assert.equal(f.am.listSuppressions().length,1);
});
test('failed suppression persistence does not report or perform deletion [AC:memory-deletion-suppression#AC-8]',async t=>{
 const f=fixture(t);const m=f.am.set(fact);
 // Real SQLite failure: no mocked persistence boundary.
 f.store.db.exec("CREATE TRIGGER reject_suppression BEFORE INSERT ON memory_suppressions BEGIN SELECT RAISE(ABORT,'disk write rejected'); END");
 await assert.rejects(route(f,'DELETE','/api/memory/:id',{id:m.id}));assert.ok(f.am.getEntryById(m.id));assert.equal(f.am.listSuppressions().length,0);
});
test('semantic merge cannot reintroduce a suppressed fact [AC:memory-deletion-suppression#AC-2]',t=>{
 const f=fixture(t);f.am.deleteAndSuppress(f.am.set(fact).id);
 f.am.set({...fact,key:'preference:other',value:'用户偏好简洁回答并提供代码示例'});
 assert.equal(learn(f.am),null);
 assert.equal(f.am.listSuppressions()[0].blockedCount,1);
});
