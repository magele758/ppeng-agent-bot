import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const supervisorPath = join(root, 'scripts', 'supervisor.mjs');

function ecosystem() {
  return require(join(root, 'ecosystem.config.cjs'));
}

function serviceApp() {
  const apps = ecosystem().apps;
  assert.equal(apps.length, 1);
  return apps[0];
}

function packageScripts() {
  return JSON.parse(require('node:fs').readFileSync(join(root, 'package.json'), 'utf8')).scripts;
}

test('PM2 服务配置是单实例监督进程 [AC:pm2-service#AC-1]', () => {
  const app = serviceApp();
  assert.equal(app.name, 'ppeng-daemon');
  assert.equal(app.cwd, root);
  assert.equal(app.script, 'scripts/supervisor.mjs');
  assert.equal(app.interpreter, process.execPath);
  assert.equal(app.exec_mode, 'fork');
  assert.equal(Number(app.instances), 1);
  assert.equal(app.autorestart, true);
  assert.notEqual(app.treekill, true);
});

test('停止服务时预留不少于 10 秒收尾 [AC:pm2-service#AC-2]', () => {
  const app = serviceApp();
  assert.ok(Number(app.kill_timeout) >= 10_000);
});

test('服务脚本不触碰夜间 evolution 任务 [AC:pm2-service#AC-1] [AC:pm2-service#AC-3]', () => {
  const scripts = packageScripts();
  assert.equal(scripts['pm2:start'], 'pm2 start ecosystem.config.cjs');
  assert.equal(scripts['pm2:stop'], 'pm2 stop ppeng-daemon');
  assert.equal(scripts['pm2:restart'], 'pm2 restart ppeng-daemon');
  assert.equal(scripts['pm2:logs'], 'pm2 logs ppeng-daemon');
  assert.equal(scripts['pm2:delete'], 'pm2 delete ppeng-daemon');
  for (const name of ['pm2:start', 'pm2:stop', 'pm2:restart', 'pm2:logs', 'pm2:delete']) {
    assert.equal(scripts[name].includes('evolution'), false);
  }
  const names = ecosystem().apps.map((app) => app.name);
  assert.deepEqual(names, ['ppeng-daemon']);
});

function writeFixture(dir, source) {
  const file = join(dir, 'daemon-fixture.mjs');
  writeFileSync(file, source);
  return file;
}

function killGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

function runSupervisor({ port, fixtureSource, graceMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'pm2-service-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, `RAW_AGENT_DAEMON_HOST=127.0.0.1\nRAW_AGENT_DAEMON_PORT=${port}\n`);
  const fixture = writeFixture(dir, fixtureSource);
  const env = { ...process.env };
  delete env.RAW_AGENT_DAEMON_HOST;
  delete env.RAW_AGENT_DAEMON_PORT;
  env.SUPERVISOR_ENV_FILE = envFile;
  env.SUPERVISOR_DAEMON_ENTRY = fixture;
  env.SUPERVISOR_MAX_RESTARTS = '1';
  env.SUPERVISOR_POLL_MS = '200';
  if (graceMs != null) env.SUPERVISOR_SHUTDOWN_GRACE_MS = String(graceMs);

  let output = '';
  const child = spawn(process.execPath, [supervisorPath], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return {
    child,
    dir,
    output: () => output,
    stop() {
      killGroup(child.pid);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('timed out'));
      }
    }, 30);
  });
}

test('停止监督进程时一起退出，并按环境文件端口探活 [AC:pm2-service#AC-1] [AC:pm2-service#AC-2]', async () => {
  const port = 39000 + (process.pid % 1000);
  const session = runSupervisor({
    port,
    fixtureSource: `
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 500);
    `,
  });
  try {
    await waitFor(() => {
      const text = session.output();
      return text.includes(`daemon=http://127.0.0.1:${port}`) && text.includes('daemon-fixture.mjs');
    }, 5000);
    process.kill(session.child.pid, 'SIGINT');
    const code = await new Promise((resolve) => session.child.once('exit', resolve));
    assert.equal(code, 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    let leftover = true;
    try {
      process.kill(-session.child.pid, 0);
      leftover = true;
    } catch {
      leftover = false;
    }
    assert.equal(leftover, false);
  } finally {
    session.stop();
  }
});

test('服务拒绝退出时在收尾窗口内被强制结束 [AC:pm2-service#AC-2]', async () => {
  const port = 40000 + (process.pid % 1000);
  const session = runSupervisor({
    port,
    graceMs: 400,
    fixtureSource: `
      process.on('SIGINT', () => {});
      process.on('SIGTERM', () => {});
      console.log('fixture-ready');
      setInterval(() => {}, 500);
    `,
  });
  try {
    await waitFor(() => session.output().includes('fixture-ready'), 5000);
    const started = Date.now();
    process.kill(session.child.pid, 'SIGINT');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('supervisor did not exit')), 4000);
      session.child.once('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 0);
    assert.match(session.output(), /sending SIGKILL/);
    assert.ok(Date.now() - started >= 300);
    assert.ok(Date.now() - started < 3500);
    let leftover = true;
    try {
      process.kill(-session.child.pid, 0);
    } catch {
      leftover = false;
    }
    assert.equal(leftover, false);
  } finally {
    session.stop();
  }
});
