import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinTools} from '../dist/tools/builtin-tools.js';
function tool(){return createBuiltinTools({}).find(t=>t.name==='bash');}
test('nonzero CLI exit with stdout and stderr is a failed result with exit evidence [AC:bot-software-execution#AC-4]',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bash-result-'));try{const result=await tool().execute({repoRoot:dir,stateDir:dir,workspaceRoot:dir,agent:{id:'test'},session:{id:'test'}},{command:"printf 'partial output'; printf 'diagnostic error' >&2; exit 7"});assert.equal(result.ok,false);assert.match(result.content,/partial output/);assert.match(result.content,/diagnostic error/);assert.equal(result.metadata.exitCode,7);assert.equal(result.metadata.signal,null);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('zero CLI exit stays successful with exit evidence [AC:bot-software-execution#AC-1]',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bash-result-'));try{const result=await tool().execute({repoRoot:dir,stateDir:dir,workspaceRoot:dir,agent:{id:'test'},session:{id:'test'}},{command:"printf 'success'"});assert.equal(result.ok,true);assert.equal(result.content,'success');assert.equal(result.metadata.exitCode,0);}finally{rmSync(dir,{recursive:true,force:true});}
});
