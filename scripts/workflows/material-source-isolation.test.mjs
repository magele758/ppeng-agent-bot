import test from 'node:test';
import assert from 'node:assert/strict';
import {updateMaterialTargets} from './material-source-isolation.mjs';
test('a deleted or failed target cannot starve later routine materials [AC:night-runtime-reliability#AC-3]',async()=>{
 const updated=[],failures=[];
 await updateMaterialTargets([['missing',{}],['failed',{}],['review',{fresh:true}]],async(name,value)=>{
  if(name==='missing')throw Error('Missing target');
  if(name==='failed')throw Error('API 503');
  updated.push([name,value]);
 },(name,error)=>failures.push([name,error.message]));
 assert.deepEqual(updated,[['review',{fresh:true}]]);
 assert.deepEqual(failures,[['missing','Missing target'],['failed','API 503']]);
});
