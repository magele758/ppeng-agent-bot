import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeUpdate, recoverUpdate, readUpdate, beginUpdate, describeUpdate } from './update-transaction.ts';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'desktop-update-test-'));
 const app=join(root,'installed.app'),candidate=join(root,'candidate.app'),data=join(root,'user');
 for(const p of [app,candidate,data])mkdirSync(p);
 writeFileSync(join(app,'version'),'old');writeFileSync(join(candidate,'version'),'new');
 writeFileSync(join(data,'history'),'formal-history');writeFileSync(join(data,'.env'),'private-test-key');
 const input={root:join(root,'updates'),app,candidate,data,currentVersion:'old',targetVersion:'new',notes:'test release'};
 const ops={preflight:async()=>{},stop:async()=>{},verify:async()=>{}};
 return {root,app,candidate,data,input,ops,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('update preview reports versions and notes without mutations [AC:desktop-safe-update#AC-1] [AC:desktop-safe-update#AC-2]',()=>{
 const f=fixture();try{assert.deepEqual(describeUpdate(f.input),{currentVersion:'old',targetVersion:'new',notes:'test release'});assert.equal(existsSync(f.input.root),false);}finally{f.cleanup();}
});
test('busy task declines update before stopping or backup [AC:desktop-safe-update#AC-3]',async()=>{
 const f=fixture();try{await assert.rejects(beginUpdate(f.input,async()=>false),/busy/);assert.equal(existsSync(join(f.input.root,'transaction.json')),false);}finally{f.cleanup();}
});
test('backup precedes replacement and keeps data/config intact [AC:desktop-safe-update#AC-4] [AC:desktop-safe-update#AC-6]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await executeUpdate(f.input.root,{...f.ops,verify:async()=>{const j=readUpdate(f.input.root)!;assert.equal(readFileSync(join(j.backup,'data','history'),'utf8'),'formal-history');assert.equal(readFileSync(join(j.backup,'app','version'),'utf8'),'old');assert.equal(readFileSync(join(f.app,'version'),'utf8'),'new');}});assert.equal(readUpdate(f.input.root)?.phase,'complete');assert.equal(readFileSync(join(f.data,'.env'),'utf8'),'private-test-key');}finally{f.cleanup();}
});
test('preflight failure leaves old version and data available [AC:desktop-safe-update#AC-5]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await assert.rejects(executeUpdate(f.input.root,{...f.ops,preflight:async()=>{throw Error('disk full');}}),/disk full/);assert.equal(readFileSync(join(f.app,'version'),'utf8'),'old');assert.equal(readFileSync(join(f.data,'history'),'utf8'),'formal-history');}finally{f.cleanup();}
});
test('failed migration restores old application and data [AC:desktop-safe-update#AC-7]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await assert.rejects(executeUpdate(f.input.root,{...f.ops,verify:async()=>{writeFileSync(join(f.data,'history'),'bad migration');throw Error('migration failed');}}),/migration failed/);assert.equal(readUpdate(f.input.root)?.phase,'rolled-back');assert.equal(readFileSync(join(f.app,'version'),'utf8'),'old');assert.equal(readFileSync(join(f.data,'history'),'utf8'),'formal-history');}finally{f.cleanup();}
});
test('interrupted update recovers from durable backup [AC:desktop-safe-update#AC-8]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await executeUpdate(f.input.root,f.ops);const j=readUpdate(f.input.root)!;j.phase='verifying';writeFileSync(join(f.input.root,'transaction.json'),JSON.stringify(j));writeFileSync(join(f.data,'history'),'partial');await recoverUpdate(f.input.root);assert.equal(readFileSync(join(f.data,'history'),'utf8'),'formal-history');assert.equal(readUpdate(f.input.root)?.phase,'rolled-back');}finally{f.cleanup();}
});
test('second update cannot overwrite pending transaction [AC:desktop-safe-update#AC-9]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await assert.rejects(beginUpdate(f.input,async()=>true),/progress/);}finally{f.cleanup();}
});
test('completion is not published until validation finishes [AC:desktop-safe-update#AC-10]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await executeUpdate(f.input.root,{...f.ops,verify:async()=>{assert.equal(readUpdate(f.input.root)?.phase,'verifying');}});assert.equal(readUpdate(f.input.root)?.phase,'complete');}finally{f.cleanup();}
});
test('incomplete backup never replaces application [AC:desktop-safe-update#AC-5]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);const j=readUpdate(f.input.root)!;mkdirSync(join(j.backup,'app'));writeFileSync(join(j.backup,'app','version'),'conflicting incomplete backup');await assert.rejects(executeUpdate(f.input.root,f.ops));assert.equal(readFileSync(join(f.app,'version'),'utf8'),'old');assert.equal(readFileSync(join(f.data,'history'),'utf8'),'formal-history');}finally{f.cleanup();}
});
test('recovery failure preserves backups and reports manual recovery [AC:desktop-safe-update#AC-8]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await executeUpdate(f.input.root,f.ops);const j=readUpdate(f.input.root)!;j.phase='verifying';writeFileSync(join(f.input.root,'transaction.json'),JSON.stringify(j));rmSync(join(j.backup,'app'),{recursive:true});await assert.rejects(recoverUpdate(f.input.root));assert.equal(readUpdate(f.input.root)?.phase,'recovery-required');assert.equal(readFileSync(join(j.backup,'data','history'),'utf8'),'formal-history');}finally{f.cleanup();}
});
test('new release cannot replace data with candidate fixtures [AC:desktop-safe-update#AC-6]',async()=>{
 const f=fixture();try{writeFileSync(join(f.candidate,'history'),'test-data');await beginUpdate(f.input,async()=>true);await executeUpdate(f.input.root,f.ops);assert.equal(readFileSync(join(f.data,'history'),'utf8'),'formal-history');}finally{f.cleanup();}
});
test('a changed staged package is rejected before install [AC:desktop-safe-update#AC-5]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await assert.rejects(executeUpdate(f.input.root,{...f.ops,validateStage:async()=>{throw Error('staged package changed');}}),/changed/);assert.equal(readFileSync(join(f.app,'version'),'utf8'),'old');}finally{f.cleanup();}
});
test('an unkillable validation process blocks rollback writes [AC:desktop-safe-update#AC-7] [AC:desktop-safe-update#AC-8]',async()=>{
 const f=fixture();try{await beginUpdate(f.input,async()=>true);await assert.rejects(executeUpdate(f.input.root,{...f.ops,verify:async()=>{throw Object.assign(Error('process alive'),{unsafeToRestore:true});}}));assert.equal(readUpdate(f.input.root)?.phase,'recovery-required');const j=readUpdate(f.input.root)!;assert.equal(readFileSync(join(j.backup,'data','history'),'utf8'),'formal-history');}finally{f.cleanup();}
});
