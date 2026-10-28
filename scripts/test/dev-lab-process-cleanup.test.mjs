import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { freePort } from '../e2e-lifecycle.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const posix = process.platform !== 'win32';
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; } catch { return false; }
  }
  return true;
}
async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(25);
  assert.ok(predicate(), message);
}
async function fixture(t, mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dev-lab-tree-'));
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'apps/daemon/dist'), {recursive:true});
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  for (const name of ['dev-lab.mjs','dev-lab-processes.mjs','spawn-utils.mjs','port-utils.mjs','dev-tailnet-https.mjs']) {
    if (existsSync(join(root,'scripts',name))) copyFileSync(join(root,'scripts',name),join(dir,'scripts',name));
  }
  const daemonPort = await freePort();
  let webPort = await freePort(); while (webPort === daemonPort) webPort = await freePort();
  const code = `import {spawn} from 'node:child_process';
import {writeFileSync,appendFileSync,existsSync,unlinkSync} from 'node:fs';
import {createServer} from 'node:net';
import {sanitizeScriptEnv} from './scripts/spawn-utils.mjs';
const mode=${JSON.stringify(mode)};
appendFileSync('pids',process.pid+'\\n');
const kind=process.argv[2];
if(kind==='exec' && mode==='spawn-fail') unlinkSync('bin/pnpm');
if(kind==='exec' && !mode.startsWith('compile')) process.exit(0);
if(kind==='exec' && mode==='compile-fail') process.exit(9);
if(kind==='leaf') {
 if(mode==='stubborn') process.on('SIGTERM',()=>{});
 createServer().listen(Number(process.argv[3]),'127.0.0.1',()=>writeFileSync('ready-'+process.argv[3],'yes'));
} else {
 const port=kind==='daemon'?process.env.RAW_AGENT_DAEMON_PORT:process.env.PORT || ${webPort};
 spawn(process.execPath,['fixture.mjs','leaf',port],{stdio:'inherit',env:sanitizeScriptEnv()});
 if(mode==='wrapper-exit' && kind!=='daemon') { const timer=setInterval(()=>{if(existsSync('ready-'+port)){clearInterval(timer);process.exit(7);}},10); }
 else setInterval(()=>{},1000);
}
`;
  writeFileSync(join(dir,'fixture.mjs'),code);
  writeFileSync(join(dir,'bin/pnpm'),`#!/bin/sh\nexec '${process.execPath}' '${join(dir,'fixture.mjs')}' "$@"\n`,{mode:0o755});
  writeFileSync(join(dir,'apps/daemon/dist/server.js'),"process.argv[2]='daemon'; await import('../../../fixture.mjs');\n");
  let child; let logs = '';
  const pids=()=>existsSync(join(dir,'pids'))?readFileSync(join(dir,'pids'),'utf8').trim().split('\n').map(Number):[];
  t.after(async()=>{
    if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    for(const pid of pids()) { try{process.kill(pid,'SIGKILL');}catch{} }
    await delay(100); rmSync(dir,{recursive:true,force:true});
  });
  const start=()=>{
    for (const port of [daemonPort,webPort]) rmSync(join(dir,'ready-'+port),{force:true});
    child=spawn(process.execPath,[join(dir,'scripts/dev-lab.mjs')],{cwd:dir,env:sanitizeScriptEnv({...process.env,PATH:join(dir,'bin')+(mode==='spawn-fail'?'':':'+process.env.PATH),RAW_AGENT_DAEMON_PORT:String(daemonPort),RAW_AGENT_WEB_PORT:String(webPort),RAW_AGENT_PORT_SPAN:'1'}),stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
    const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    return {child,done};
  };
  const ready=async()=>until(()=>existsSync(join(dir,'ready-'+webPort)) && (mode.startsWith('compile') || existsSync(join(dir,'ready-'+daemonPort))),logs);
  const gone=async()=>{for(const pid of pids()) await until(()=>!alive(pid),`pid ${pid} remains; ${logs}`,1500);};
  return {dir,daemonPort,webPort,pids,start,ready,gone};
}
async function bind(port) {
  const server=createServer(); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await new Promise(resolve=>server.close(resolve));
}

test('launcher signals clean descendants and allow the same ports on restart [AC:dev-lab-process-cleanup#AC-1] [AC:single-host-bot-completion#AC-6]',{skip:!posix,timeout:30000},async t=>{
  const f=await fixture(t);
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:sanitizeScriptEnv(),stdio:'ignore'});
  t.after(()=>sentinel.kill());
  for(const signal of ['SIGTERM','SIGINT','SIGHUP']) {
    const {child,done}=f.start(); await f.ready();
    // Each restart must reach its new process tree, rather than relying on stale ready files.
    await until(()=>f.pids().filter(alive).length>=4,'new tree started');
    child.kill(signal); assert.equal((await done).code,{SIGTERM:143,SIGINT:130,SIGHUP:129}[signal]); await f.gone();
    await bind(f.daemonPort);await bind(f.webPort);
    assert.ok(alive(sentinel.pid),'unrelated service survives');
    const ports=JSON.parse(readFileSync(join(f.dir,'.agent-state/dev-lab.ports.json'),'utf8'));
    assert.equal(ports.webPort,f.webPort);assert.equal(ports.daemonPort,f.daemonPort);
  }
});
test('an exited wrapper does not strand its listener or peer service [AC:dev-lab-process-cleanup#AC-2]',{skip:!posix,timeout:15000},async t=>{
 const f=await fixture(t,'wrapper-exit');const {done}=f.start();assert.equal((await done).code,7);await f.gone();await bind(f.webPort);await bind(f.daemonPort);
});
test('stubborn descendants and repeated signals are cleaned before exit [AC:dev-lab-process-cleanup#AC-3]',{skip:!posix,timeout:15000},async t=>{
 const f=await fixture(t,'stubborn');const {child,done}=f.start();await f.ready();child.kill('SIGTERM');await delay(100);child.kill('SIGTERM');await done;await f.gone();await bind(f.webPort);await bind(f.daemonPort);
});
test('interruption during compilation cleans the compile tree without starting services [AC:dev-lab-process-cleanup#AC-4]',{skip:!posix,timeout:15000},async t=>{
 const f=await fixture(t,'compile-wait');const {child,done}=f.start();await f.ready();child.kill('SIGTERM');await done;await f.gone();assert.ok(!existsSync(join(f.dir,'ready-'+f.daemonPort)));await bind(f.webPort);
});
test('compile failures preserve status and never start services [AC:dev-lab-process-cleanup#AC-4]',{skip:!posix,timeout:15000},async t=>{
 const f=await fixture(t,'compile-fail');const {done}=f.start();assert.equal((await done).code,9);await f.gone();assert.ok(!existsSync(join(f.dir,'ready-'+f.daemonPort)));assert.ok(!existsSync(join(f.dir,'ready-'+f.webPort)));
});

test('a web spawn error returns failure and cleans the already spawned daemon [AC:dev-lab-process-cleanup#AC-2]',{skip:!posix,timeout:15000},async t=>{
 const f=await fixture(t,'spawn-fail');const {done}=f.start();assert.equal((await done).code,1);await f.gone();await bind(f.daemonPort);await bind(f.webPort);
});

test('an EPERM probe distinguishes vanished or zombie groups from live protected members [AC:dev-lab-process-cleanup#AC-3]', {skip:!posix}, async () => {
 const { groupExists } = await import('../dev-lab-processes.mjs');
 const denied = Object.assign(new Error('kill EPERM'),{code:'EPERM'});
 const kill = () => {throw denied;};
 assert.equal(groupExists({pid:501},{kill,listGroups:()=>''}),false);
 assert.equal(groupExists({pid:501},{kill,listGroups:()=> '12 501 Z\n13 502 S'}),false);
 assert.throws(()=>groupExists({pid:501},{kill,listGroups:()=> '12 501 S'}),error=>error===denied);
 assert.throws(()=>groupExists({pid:501},{kill,listGroups:()=> {throw Error('ps failed');}}),error=>error===denied);
 assert.throws(()=>groupExists({pid:501},{kill,listGroups:()=> 'unparseable'}),error=>error===denied);
});

test('exit probes retry transient permission errors but preserve persistent failures [AC:dev-lab-process-cleanup#AC-3]', async () => {
 const { waitForGroupExit } = await import('../dev-lab-processes.mjs');
 const denied=Object.assign(new Error('exit race'),{code:'EPERM'});
 let calls=0;
 assert.equal(await waitForGroupExit({pid:501},100,()=>{if(++calls===1)throw denied;return false;}),true);
 assert.ok(calls>=2);
 await assert.rejects(waitForGroupExit({pid:501},30,()=>{throw denied;}),error=>error===denied);
 assert.equal(await waitForGroupExit({pid:501},30,()=>true),false);
 const other=Object.assign(new Error('unexpected failure'),{code:'EINVAL'});
 await assert.rejects(waitForGroupExit({pid:501},100,()=>{throw other;}),error=>error===other);
});
