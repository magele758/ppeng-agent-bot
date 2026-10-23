import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDevHttps } from '../dev-tailnet-https.mjs';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-https-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.agent-state');
  mkdirSync(dir);
  const configPath = join(dir, 'dev-https.json');
  writeFileSync(configPath, JSON.stringify({ enabled: true, httpsPort: 23443, lastTarget: 'http://127.0.0.1:23000' }));
  const calls = [], logs = [];
  const host = 'fixture.example.ts.net';
  let serveState = { TCP: { 23443: { HTTPS: true } }, Web: { [`${host}:23443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:23000' } } } } };
  const options = {
    root, webPort: 23001, log: line => logs.push(line), waitReady: async () => {},
    run: (args) => {
      calls.push(args);
      if (args[0] === 'status') return { BackendState: 'Running', Self: { DNSName: `${host}.` }, User: { private: 'private-account' } };
      if (args[1] === 'status') return serveState;
      serveState.Web[`${host}:23443`].Handlers['/'].Proxy = args.at(-1);
      return {};
    },
    ...overrides
  };
  return { root, dir, calls, logs, options, configPath, setServe: value => { serveState = value; } };
}

test('ready startup retargets actual port and next startup follows it [AC:dev-tailnet-https#AC-1]', async t => {
  const f = fixture(t);
  const result = await syncDevHttps(f.options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(f.calls.find(a => a.includes('--bg')), ['serve', '--bg', '--https=23443', 'http://127.0.0.1:23001']);
  assert.equal(JSON.parse(readFileSync(f.configPath)).lastTarget, 'http://127.0.0.1:23001');
  await syncDevHttps({ ...f.options, webPort: 23002 });
  assert.ok(f.calls.some(a => a.at(-1) === 'http://127.0.0.1:23002'));
});

test('unowned service and Funnel are never overwritten [AC:dev-tailnet-https#AC-2]', async t => {
  for (const state of [
    { TCP: {23443: {HTTPS:true}}, Web: {'fixture.example.ts.net:23443': {Handlers: {'/': {Proxy:'http://127.0.0.1:9999'}}}} },
    { AllowFunnel: {'fixture.example.ts.net:23443': true} },
    { TCP: {23443: {TCPForward:'localhost:9999'}} },
    { TCP: {23443: {HTTPS:true}}, Web: {'fixture.example.ts.net:23443': {Handlers: {'/other': {Proxy:'http://127.0.0.1:9999'}}}} }
  ]) {
    const f=fixture(t); f.setServe(state);
    assert.equal((await syncDevHttps(f.options)).status, 'unavailable');
    assert.equal(f.calls.some(a=>a.includes('--bg')), false);
  }
});

test('unready server, cancellation and private CLI failure keep HTTP and omit stale status [AC:dev-tailnet-https#AC-3] [AC:dev-tailnet-https#AC-4]', async t => {
  for (const overrides of [
    {waitReady: async()=>{throw new Error('not-ready');}},
    {run: ()=>{throw new Error('secret-token private-account fixture.example.ts.net');}},
    {run: ()=>({BackendState:'NeedsLogin'})},
    {signal: AbortSignal.abort()}
  ]) {
    const f=fixture(t,overrides);
    writeFileSync(join(f.dir,'dev-https.status.json'), '{}');
    assert.equal((await syncDevHttps(f.options)).status,'unavailable');
    assert.equal(f.calls.some(a=>a.includes('--bg')),false);
    assert.equal(existsSync(join(f.dir,'dev-https.status.json')),false);
    assert.doesNotMatch(f.logs.join(' '),/secret-token|private-account|fixture.example/);
  }
});

test('private local state and quiet unconfigured clones [AC:dev-tailnet-https#AC-4]', async t => {
  const f=fixture(t); await syncDevHttps(f.options);
  const path=join(f.dir,'dev-https.status.json');
  const saved=JSON.parse(readFileSync(path));
  assert.equal(saved.httpsUrl,'https://fixture.example.ts.net:23443');
  assert.doesNotMatch(readFileSync(path,'utf8'),/private-account|User|token/);
  if(process.platform!=='win32') assert.equal(statSync(path).mode & 0o777,0o600);
  assert.doesNotMatch(f.logs.join(' '),/fixture.example|private-account/);
  rmSync(f.configPath); f.calls.length=0;
  assert.equal((await syncDevHttps(f.options)).status,'disabled');
  assert.equal(f.calls.length,0);
});

test('malformed configuration never calls CLI and HTTPS binds loopback [AC:dev-tailnet-https#AC-3] [AC:dev-tailnet-https#AC-4]', async t => {
  const {devWebHost}=await import('../dev-tailnet-https.mjs');
  const f=fixture(t);
  assert.equal(devWebHost(f.root),'127.0.0.1');
  for(const data of ['{', '{"enabled":true,"httpsPort":0}', '{"enabled":true,"httpsPort":"443"}']) {
    writeFileSync(f.configPath,data);
    assert.equal((await syncDevHttps(f.options)).status,'unavailable');
    assert.equal(f.calls.length,0);
  }
  rmSync(f.configPath);
  assert.equal(devWebHost(f.root),'0.0.0.0');
});

test('actual readiness waits through server error and responds to shutdown [AC:dev-tailnet-https#AC-1] [AC:dev-tailnet-https#AC-3]', async t => {
  const {createServer}=await import('node:http');
  const {waitForLab}=await import('../dev-tailnet-https.mjs');
  let ready=false, hits=0;
  const server=createServer((req,res)=>{hits++;res.writeHead(ready?200:503);res.end();ready=true;});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const target=`http://127.0.0.1:${server.address().port}`;
  await waitForLab(target);
  assert.ok(hits>=2);
  await assert.rejects(waitForLab(target,AbortSignal.abort()));
});
