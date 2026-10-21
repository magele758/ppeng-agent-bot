import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {createServer} from 'node:net';
import {sanitizeScriptEnv} from '../../spawn-utils.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
async function port(){return new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
async function daemon(validation,fn){
 const dir=mkdtempSync(join(tmpdir(),'desktop-update-daemon-'));mkdirSync(join(dir,'cron'));
 const jobs=JSON.stringify([{id:'due-test',sessionId:'nonexistent-test-session',agentId:'general',name:'test only',prompt:'test only',scheduleKind:'every_ms',scheduleValue:'1000',enabled:true,nextRunAt:'2020-01-01T00:00:00Z',createdAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:00Z',metadata:{}}]);
 if(validation)writeFileSync(join(dir,'cron/jobs.json'),jobs);
 const p=await port();const env=sanitizeScriptEnv({PATH:process.env.PATH,HOME:dir,RAW_AGENT_STATE_DIR:dir,RAW_AGENT_DAEMON_HOST:'127.0.0.1',RAW_AGENT_DAEMON_PORT:String(p),RAW_AGENT_E2E_ISOLATE:'1',RAW_AGENT_SELF_HEAL_AUTO_START:'0'});
 const child=spawn(process.execPath,[join(root,'apps/daemon/dist/server.js'),...(validation?['--desktop-update-validation']:[])],{cwd:dir,env,stdio:['ignore','pipe','pipe','ipc']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 try{let ready=false;for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${p}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,log);await fn({child,base:`http://127.0.0.1:${p}`,dir,jobs});}
 finally{const exited=new Promise(r=>child.once('exit',r));if(child.exitCode===null){child.kill('SIGTERM');await exited;}rmSync(dir,{recursive:true,force:true});}
}
test('real validation daemon blocks requests and due routines [AC:desktop-safe-update#AC-10]',async()=>{
 await daemon(true,async({base,dir,jobs})=>{
 assert.equal((await (await fetch(base+'/api/health')).json()).desktopUpdateValidation,true);
 assert.equal((await fetch(base+'/api/sessions')).status,503);
 assert.equal((await fetch(base+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);
 await new Promise(r=>setTimeout(r,2000));assert.equal(readFileSync(join(dir,'cron/jobs.json'),'utf8'),jobs);
 });
});
test('desktop IPC freezes a live daemon and can cancel preparation [AC:desktop-safe-update#AC-3] [AC:desktop-safe-update#AC-9]',async()=>{
 await daemon(false,async({child,base})=>{
 const response=new Promise((r,reject)=>{const timeout=setTimeout(()=>reject(Error('IPC timeout')),5000);child.once('message',m=>{clearTimeout(timeout);r(m);});});
 child.send({type:'desktop-update-prepare'});assert.deepEqual(await response,{type:'desktop-update-prepared',ok:true});
 assert.equal((await fetch(base+'/api/sessions')).status,503);
 child.send({type:'desktop-update-cancel'});await new Promise(r=>setTimeout(r,100));assert.equal((await fetch(base+'/api/health')).status,200);
 });
});
