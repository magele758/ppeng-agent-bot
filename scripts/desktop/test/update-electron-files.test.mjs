import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {dirname,resolve,join} from 'node:path';import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {sanitizeScriptEnv} from '../../spawn-utils.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),require=createRequire(join(root,'package.json'));
test('Electron backs up ASAR as bytes rather than a virtual directory [AC:desktop-safe-update#AC-4]',()=>{
 const electron=createRequire(join(root,'apps/desktop/package.json'))('electron');
 const ts=require('typescript'),dir=mkdtempSync(join(tmpdir(),'update-electron-files-'));
 try{
  const resources=process.platform==='darwin'?resolve(electron,'../../Resources'):join(dirname(electron),'resources');
  const source=join(dir,'source');mkdirSync(source);copyFileSync(join(resources,'default_app.asar'),join(source,'app.asar'));
  const compiled=ts.transpileModule(readFileSync(join(root,'apps/desktop/src/update-transaction.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  writeFileSync(join(dir,'transaction.cjs'),compiled);
  writeFileSync(join(dir,'check.cjs'),`const fs=require('original-fs');const path=require('node:path');const {copyUpdateTree}=require('./transaction.cjs');copyUpdateTree(path.join(__dirname,'source'),path.join(__dirname,'backup'));if(!fs.readFileSync(path.join(__dirname,'source/app.asar')).equals(fs.readFileSync(path.join(__dirname,'backup/app.asar'))))throw Error('ASAR bytes changed');console.log('ok');`);
  const output=execFileSync(electron,[join(dir,'check.cjs')],{env:sanitizeScriptEnv({PATH:process.env.PATH,HOME:dir,ELECTRON_RUN_AS_NODE:'1'}),encoding:'utf8',timeout:30_000});assert.match(output,/ok/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
