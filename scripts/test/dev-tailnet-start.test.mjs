import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from '../port-utils.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const source = resolve(import.meta.dirname, '../..');

test('dev entrypoint waits for web and synchronizes occupied-port restarts without identity logs [AC:dev-tailnet-https#AC-1] [AC:dev-tailnet-https#AC-4]', {timeout:30000}, async t => {
  const root=mkdtempSync(join(tmpdir(),'tailnet-start-'));
  const blocker=createServer();
  const lowPort = await pickPort(18000 + Math.floor(Math.random() * 1000), 200);
  await new Promise(r=>blocker.listen(lowPort,'127.0.0.1',r));
  const preferred=blocker.address().port;
  let child, output='';
  const stop=async()=>{
    if(child && child.exitCode===null) {const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;await delay(100);}
  };
  t.after(async()=>{await stop();blocker.close();rmSync(root,{recursive:true,force:true});});
  for(const dir of ['scripts','apps/daemon/dist','bin','.agent-state']) mkdirSync(join(root,dir),{recursive:true});
  for(const file of ['dev-lab.mjs','dev-tailnet-https.mjs','spawn-utils.mjs','port-utils.mjs']) copyFileSync(join(source,'scripts',file),join(root,'scripts',file));
  symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
  writeFileSync(join(root,'apps/daemon/dist/server.js'),'setInterval(()=>{},1000);');
  const executable=(name,body)=>writeFileSync(join(root,'bin',name),`#!${process.execPath}\n${body}`,{mode:0o755});
  executable('pnpm',`const http=require('node:http');const args=process.argv.slice(2);if(args[0]==='exec')process.exit(0);http.createServer((q,s)=>s.end('Lab ready')).listen(Number(args[args.indexOf('-p')+1]),args[args.indexOf('-H')+1]);`);
  executable('tailscale',`const fs=require('node:fs');if(process.env.RAW_AGENT_API_KEY)throw new Error('credential leaked');const args=process.argv.slice(2),file='.fake-serve.json',host='fixture.example.ts.net:23443';if(args[0]==='status'){console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.example.ts.net.'},User:{email:'private-account'}}));}else if(args[1]==='status'){console.log(fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{}');}else{fs.writeFileSync(file,JSON.stringify({TCP:{23443:{HTTPS:true}},Web:{[host]:{Handlers:{'/':{Proxy:args.at(-1)}}}}}));console.log('fixture.example.ts.net private-account');}`);
  writeFileSync(join(root,'.agent-state/dev-https.json'),JSON.stringify({enabled:true,httpsPort:23443}));
  async function start() {
    rmSync(join(root,'.agent-state/dev-https.status.json'),{force:true});
    child=spawn(process.execPath,['scripts/dev-lab.mjs'],{cwd:root,env:sanitizeScriptEnv({...process.env,PATH:join(root,'bin')+':'+process.env.PATH,RAW_AGENT_WEB_PORT:String(preferred),RAW_AGENT_DAEMON_PORT:String(preferred),RAW_AGENT_API_KEY:'fixture-secret'}),stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const statusPath=join(root,'.agent-state/dev-https.status.json');
    for(let i=0;i<100&&!existsSync(statusPath);i++){assert.equal(child.exitCode,null,output);await delay(50);}
    assert.ok(existsSync(statusPath),output);
    const ports=JSON.parse(readFileSync(join(root,'.agent-state/dev-lab.ports.json')));
    const status=JSON.parse(readFileSync(statusPath));
    assert.equal(status.target,`http://127.0.0.1:${ports.webPort}`);
    assert.notEqual(ports.webPort,preferred);
    assert.equal((await fetch(status.target)).status,200);
    assert.doesNotMatch(output,/fixture\.example|private-account|fixture-secret/);
    return ports.webPort;
  }
  const first=await start();
  await stop();
  const nextBlock=createServer();
  await new Promise(r=>nextBlock.listen(first,'127.0.0.1',r));
  t.after(()=>nextBlock.close());
  const second=await start();
  assert.notEqual(first,second);
  assert.equal(JSON.parse(readFileSync(join(root,'.agent-state/dev-https.json'))).lastTarget,`http://127.0.0.1:${second}`);
});
