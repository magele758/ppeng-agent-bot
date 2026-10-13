import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {preparePinnedCheckout} from '../migration-fixtures/pinned-checkout.mjs';
import {sanitizeSpawnEnv} from '../../packages/core/dist/sandbox/env-sanitizer.js';

function git(cwd,args){const result=spawnSync('git',args,{cwd,encoding:'utf8',env:sanitizeSpawnEnv(),timeout:30000});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
function repository(root){const origin=join(root,'origin');mkdirSync(origin);git(origin,['init','--quiet']);writeFileSync(join(origin,'revision.txt'),'old schema v24');git(origin,['add','revision.txt']);git(origin,['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','--quiet','-m','historical']);const sha=git(origin,['rev-parse','HEAD']);writeFileSync(join(origin,'revision.txt'),'new schema v25');git(origin,['add','revision.txt']);git(origin,['-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','--quiet','-m','candidate']);return {origin,sha};}

test('migration fixture retrieves the exact old revision from a depth-one checkout without mutating it [AC:schema-upgrade-safety#AC-1] [AC:schema-upgrade-safety#AC-2]',()=>{
 const root=mkdtempSync(join(tmpdir(),'pinned-migration-ci-'));
 try{
  const {origin,sha}=repository(root),sourceRoot=join(root,'shallow'),checkout=join(root,'fixture');
  git(root,['clone','--quiet','--depth=1',pathToFileURL(origin).href,sourceRoot]);
  const before={head:git(sourceRoot,['rev-parse','HEAD']),shallow:readFileSync(join(sourceRoot,'.git/shallow'),'utf8'),config:readFileSync(join(sourceRoot,'.git/config'),'utf8'),fetchHead:existsSync(join(sourceRoot,'.git/FETCH_HEAD'))?readFileSync(join(sourceRoot,'.git/FETCH_HEAD'),'utf8'):null};
  assert.notEqual(spawnSync('git',['cat-file','-e',`${sha}^{commit}`],{cwd:sourceRoot,env:sanitizeSpawnEnv(),stdio:'ignore'}).status,0);
  assert.deepEqual(preparePinnedCheckout({sourceRoot,checkout,sha}),{sha,source:'origin-pinned-object'});
  assert.equal(git(checkout,['rev-parse','HEAD']),sha);assert.equal(readFileSync(join(checkout,'revision.txt'),'utf8'),'old schema v24');
  const after={head:git(sourceRoot,['rev-parse','HEAD']),shallow:readFileSync(join(sourceRoot,'.git/shallow'),'utf8'),config:readFileSync(join(sourceRoot,'.git/config'),'utf8'),fetchHead:existsSync(join(sourceRoot,'.git/FETCH_HEAD'))?readFileSync(join(sourceRoot,'.git/FETCH_HEAD'),'utf8'):null};
  assert.deepEqual(after,before);assert.notEqual(spawnSync('git',['cat-file','-e',`${sha}^{commit}`],{cwd:sourceRoot,env:sanitizeSpawnEnv(),stdio:'ignore'}).status,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('migration fixture uses a locally available immutable object without depending on an origin [AC:schema-upgrade-safety#AC-2]',()=>{
 const root=mkdtempSync(join(tmpdir(),'pinned-migration-local-'));
 try{const {origin,sha}=repository(root),checkout=join(root,'fixture');assert.deepEqual(preparePinnedCheckout({sourceRoot:origin,checkout,sha}),{sha,source:'local-object'});assert.equal(git(checkout,['rev-parse','HEAD']),sha);assert.throws(()=>preparePinnedCheckout({sourceRoot:origin,checkout:join(root,'bad'),sha:sha.slice(0,7)}),/complete immutable/);}finally{rmSync(root,{recursive:true,force:true});}
});
