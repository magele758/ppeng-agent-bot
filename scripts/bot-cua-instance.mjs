#!/usr/bin/env node
import {createRequire} from 'node:module';
/** Isolated, retained CUA fixture. Starts no browser and never rebuilds artifacts. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, runWithCleanup } from './e2e-lifecycle.mjs';
import { envForEphemeralDaemon } from './spawn-utils.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) {
  console.log('node scripts/bot-cua-instance.mjs\nStarts isolated daemon + built Lab + local HTTP fixture; prints URLs and fixture JSON. Keep running during CUA. Ctrl+C cleans process groups and temporary state. No browser/build or real credentials; creates an ephemeral local test Bearer.');
  process.exit(0);
}
let fixture;
async function waitReady(url, registry) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    registry.assertAlive();
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Readiness timeout: ${url}`);
}
async function main(registry) {
  const nextDir = join(root, 'apps/web-console/.next');
  if (!existsSync(join(root, 'apps/daemon/dist/server.js')) || !existsSync(join(nextDir, 'BUILD_ID'))) throw new Error('Build artifacts missing. Build the reviewed candidate before starting this fixture.');
  const manifest = JSON.parse(readFileSync(join(nextDir, 'routes-manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.dataRoutes)) throw new Error('A complete production Next build is required.');
  const stateDir = registry.trackDir(mkdtempSync(join(tmpdir(), 'ppeng-cua-')));
  const daemonPort = await freePort();
  let webPort = await freePort();
  while (webPort === daemonPort) webPort = await freePort();
  const daemonBase = `http://127.0.0.1:${daemonPort}`;
  const webBase = `http://127.0.0.1:${webPort}`;
  // Allowlist OS basics only. Do not inherit model, cloud, OAuth or proxy secrets.
  const basics = Object.fromEntries(['PATH','TMPDIR','TEMP','TMP','LANG','TZ','SystemRoot'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const token = randomBytes(24).toString('hex');
  const env = { ...envForEphemeralDaemon(basics), RAW_AGENT_MODEL_PROVIDER: 'heuristic', RAW_AGENT_E2E_ISOLATE: '1', RAW_AGENT_STATE_DIR: stateDir, RAW_AGENT_SELF_HEAL_AUTO_START: '0', RAW_AGENT_AUTH_TOKEN: token };
  const daemonChild = registry.spawnService('daemon', process.execPath, ['apps/daemon/dist/server.js'], { cwd: root, env: { ...env, RAW_AGENT_DAEMON_HOST:'127.0.0.1',RAW_AGENT_DAEMON_PORT:String(daemonPort) } });
  const nextChild = registry.spawnService('next', process.execPath, [createRequire(join(root,'apps/web-console/package.json')).resolve('next/dist/bin/next'),'start','-p',String(webPort),'-H','127.0.0.1'], { cwd:join(root,'apps/web-console'),env:{...env,DAEMON_PROXY_TARGET:daemonBase} });
  fixture = createServer((req,res) => {
    res.setHeader('Content-Type','application/json');
    if (req.method === 'GET' && req.url?.split('?')[0] === '/weather') res.end(JSON.stringify({ city:'Fixture City',temperature:21,marker:'CUA_LOCAL_SOFTWARE_OK' }));
    else { res.statusCode=404;res.end(JSON.stringify({error:'Fixture route not found'})); }
  });
  await new Promise((resolve,reject) => { fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve); });
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  await waitReady(`${daemonBase}/api/health`,registry);await waitReady(webBase,registry);
  async function api(path,body) {
    const response = await fetch(`${webBase}${path}`, { method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Fixture API ${path} returned ${response.status}`);
    return response.json();
  }
  const {bot:superBot} = await api('/api/bot-work/default');
  const {bot} = await api('/api/bots',{name:'CUA Worker'});
  const {session} = await api(`/api/bots/${bot.id}/open`,{});
  for(let i=0;i<55;i++) await api(`/api/sessions/${session.id}/messages`,{message:i===0?'CUA historical anchor 77331':`CUA historical item ${i}`,autoRun:false});
  const {messages} = await api(`/api/sessions/${session.id}/history?query=anchor`);
  const source=messages.find(message=>message.role==='user');
  await api('/api/memory',{scope:'user.memory',agentId:bot.id,key:'cua-favorite-color',value:'green',sourceRefs:[{sessionId:session.id,messageId:source.id,seq:source.seq}]});
  const info={runnerPid:process.pid,childPids:[daemonChild.pid,nextChild.pid],webBase,daemonBase,stateDir,superBotId:superBot.id,botId:bot.id,sessionId:session.id,fixtureBase,openApi:{openapi:'3.0.3',info:{title:'CUA local weather',version:'1'},servers:[{url:fixtureBase}],paths:{'/weather':{get:{operationId:'readWeather',responses:{200:{description:'Local fixture result'}}}}}}};
  const infoPath=join(stateDir,'cua-instance.json');writeFileSync(infoPath,JSON.stringify(info,null,2));
  console.log(JSON.stringify({...info,infoPath},null,2));
  console.log('READY: keep this process alive. Open webBase with the separately available CUA computer. Ctrl+C cleans up.');
  await new Promise((resolve,reject)=>{const timer=setInterval(()=>{try{registry.assertAlive();}catch(error){clearInterval(timer);reject(error);}},1000);});
  return 0;
}
try { process.exitCode = await runWithCleanup(main); } finally { fixture?.close(); }
