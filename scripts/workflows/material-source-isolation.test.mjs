import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
test('target preparation failures are recorded while other targets receive fresh materials [AC:night-runtime-reliability#AC-3]',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'material-prep-'));
 try {
  const metrics=path.join(folder,'metrics.json');
  fs.writeFileSync(metrics,'{broken');
  const updated=[],failures=[];
  const cube=async()=>{throw Error('Cube state unavailable');};
  await updateMaterialTargets([
   ['directory',()=>fs.readdirSync(path.join(folder,'missing'))],
   ['json',()=>JSON.parse(fs.readFileSync(metrics,'utf8'))],
   ['cube',()=>cube()],
   ['review',()=>({fresh:true})],
   ['status',{fresh:true}]
  ],async(name,value)=>updated.push([name,value]),(name,error)=>failures.push([name,error]));
  assert.deepEqual(updated,[['review',{fresh:true}],['status',{fresh:true}]]);
  assert.deepEqual(failures.map(([name])=>name),['directory','json','cube']);
  assert.equal(failures[0][1].code,'ENOENT');
  assert.ok(failures[1][1] instanceof SyntaxError);
  assert.equal(failures[2][1].message,'Cube state unavailable');
 } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});
