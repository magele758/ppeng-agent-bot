import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,writeFileSync,rmSync,existsSync,readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {sanitizeScriptEnv} from '../spawn-utils.mjs';
const root=resolve(import.meta.dirname,'../..');
async function occupied(){const server=createServer();await new Promise(r=>server.listen(0,'0.0.0.0',r));return {server,port:server.address().port};}

test('isolated pnpm dev survives occupied ports and needs no npm/npx executor [AC:pnpm-migration#AC-3] [AC:pnpm-migration#AC-14]',{timeout:120000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pnpm-dev-test-')),shim=join(dir,'test-bin');
 const daemonBlock=await occupied(),webBlock=await occupied();let child,output='';
 try{
  mkdirSync(shim);for(const name of ['npm','npx'])writeFileSync(join(shim,name),'#!/bin/sh\necho forbidden-package-executor >&2\nexit 97\n',{mode:0o755});
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const file of files){const source=join(root,file);if(!existsSync(source)||file==='package-lock.json'||file==='yarn.lock')continue;const target=join(dir,file);mkdirSync(resolve(target,'..'),{recursive:true});cpSync(source,target);}
  const installed=spawnSync('pnpm',['install','--offline','--frozen-lockfile','--ignore-scripts'],{cwd:dir,env:sanitizeScriptEnv(),encoding:'utf8',timeout:60000});
  assert.equal(installed.status,0,installed.stdout+installed.stderr);
  child=spawn('pnpm',['dev'],{cwd:dir,env:sanitizeScriptEnv({...process.env,PATH:shim+':'+process.env.PATH,RAW_AGENT_DAEMON_PORT:String(daemonBlock.port),RAW_AGENT_WEB_PORT:String(webBlock.port),RAW_AGENT_MODEL_PROVIDER:'heuristic',RAW_AGENT_E2E_ISOLATE:'1',RAW_AGENT_AUTH_TOKEN:'pnpm-dev-test-token',RAW_AGENT_SELF_HEAL_AUTO_START:'0',EVOLUTION_AUTO_START:'0'}),detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const portsFile=join(dir,'.agent-state/dev-lab.ports.json');let ports,ready=false;
  for(let i=0;i<160;i++){
   if(child.exitCode!==null)throw new Error(output.slice(-4000));
   if(existsSync(portsFile)){
    ports=JSON.parse(readFileSync(portsFile,'utf8'));
    try{const health=await fetch(ports.labUrl+'/api/health',{headers:{Authorization:'Bearer pnpm-dev-test-token'},signal:AbortSignal.timeout(1500)});if(health.ok){ready=true;break;}}catch{}
   }
   await delay(500);
  }
  assert.equal(ready,true,output.slice(-4000));assert.notEqual(ports.daemonPort,daemonBlock.port);assert.notEqual(ports.webPort,webBlock.port);assert.ok(!output.includes('forbidden-package-executor'));
 }finally{
  if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}await delay(500);try{process.kill(-child.pid,'SIGKILL');}catch{}}
  daemonBlock.server.close();webBlock.server.close();rmSync(dir,{recursive:true,force:true});
 }
});
