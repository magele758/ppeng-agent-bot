import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkToolApprovals } from '@ppeng/agent-loop';
import {
  APP_CONTROL_SETTINGS_KEY,
  APP_CONTROL_TOOL_NAMES,
  readAppControlSettings,
  writeAppControlSettings
} from '../dist/app-control/settings.js';
import { APP_CONTROL_SCRIPTS, planAppControlCall } from '../dist/app-control/script.js';
import { createAppControlTools } from '../dist/app-control/tools.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { appControlRoutes } from '../../../apps/daemon/dist/routes/app-control.js';

const session = {
  id: 's1',
  title: 'app',
  mode: 'chat',
  status: 'idle',
  agentId: 'general',
  background: false,
  todo: [],
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};
const agent = { id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] };
const context = { repoRoot: '/tmp', stateDir: '/tmp', session, agent };

function memoryStore(initial) {
  const data = new Map(initial ? [[APP_CONTROL_SETTINGS_KEY, initial]] : []);
  return {
    data,
    getDaemonControl(key) { return data.get(key); },
    setDaemonControl(key, value) { data.set(key, value); }
  };
}

function approvals(rows = []) {
  return { listApprovals(filter) { return rows.filter((row) => !filter?.status || row.status === filter.status); } };
}

function approved(toolName, args) {
  return approvals([{ sessionId: 's1', toolName, status: 'approved', args, idempotencyKey: `approved:${toolName}` }]);
}

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  return { calls, spawn };
}

function tools(options) {
  const spawned = options.spawned ?? fakeSpawn();
  return {
    spawned,
    list: createAppControlTools({
      enabled: options.enabled ?? (() => true),
      approvals: options.approvals ?? approvals(),
      platform: options.platform ?? (() => 'darwin'),
      spawn: options.spawn ?? spawned.spawn,
      osascriptPath: '/usr/bin/osascript'
    })
  };
}

async function run(list, name, args) {
  const tool = list.find((item) => item.name === name);
  assert.ok(tool, name);
  return tool.execute(context, args);
}

test('app control stays off until Lab saves it, then the three actions appear [AC:macos-app-control#AC-1]', async () => {
  const store = memoryStore();
  store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  assert.deepEqual(readAppControlSettings(store), { enabled: false });
  assert.deepEqual(APP_CONTROL_TOOL_NAMES, ['app_activate', 'app_type_text', 'app_keystroke']);
  const catalog = createAppControlTools({ enabled: () => false, approvals: approvals(), platform: () => 'linux', spawn() { throw new Error('spawned'); } });
  const hidden = filterToolsForSession({ env: {}, tools: catalog, agent, session, settingsStore: store });
  assert.deepEqual(hidden.tools.map((tool) => tool.name), []);

  const saved = writeAppControlSettings(store, { enabled: true });
  assert.equal(saved.enabled, true);
  assert.equal(store.data.get(APP_CONTROL_SETTINGS_KEY).enabled, true);
  const shown = filterToolsForSession({ env: {}, tools: catalog, agent, session, settingsStore: store });
  assert.deepEqual(shown.tools.map((tool) => tool.name), [...APP_CONTROL_TOOL_NAMES]);

  writeAppControlSettings(store, { enabled: false });
  const again = filterToolsForSession({ env: {}, tools: catalog, agent, session, settingsStore: store });
  assert.deepEqual(again.tools.map((tool) => tool.name), []);

  const runtime = { store };
  const patch = appControlRoutes(runtime).find((route) => route.method === 'PATCH');
  let payload;
  const response = { statusCode: 200, setHeader() {}, end(text) { payload = JSON.parse(text); } };
  await patch.handler({ response, readBody: async () => ({ enabled: true }) });
  assert.equal(payload.settings.enabled, true);
  assert.equal(readAppControlSettings(store).enabled, true);
});

test('script, shell, and URL arguments are rejected and do not spawn [AC:macos-app-control#AC-2]', async () => {
  const { list, spawned } = tools({});
  const samples = [
    ['app_activate', { app: 'TextEdit"\ndo shell script "id' }],
    ['app_activate', { app: 'do shell script "curl evil"' }],
    ['app_activate', { app: 'Cursor', script: 'tell application "Finder" to activate' }],
    ['app_type_text', { text: 'hello\ndo shell script "id"' }],
    ['app_type_text', { text: 'tell application "Terminal" to do shell script "id"' }],
    ['app_type_text', { text: 'https://evil.example/hook' }],
    ['app_type_text', { text: 'cursor://anysphere.cursor-mcp/install' }],
    ['app_type_text', { text: 'javascript:alert(1)' }],
    ['app_keystroke', { key: 'return & do shell script "id"' }],
    ['app_activate', { app: 'open location "file:///etc/passwd"' }],
    ['app_activate', { app: 'osascript -e beep' }],
    ['app_type_text', { text: 'run script "evil"' }],
    ['app_type_text', { text: 'hello `id`' }],
    ['app_type_text', { text: 'hello $(id)' }],
    ['app_type_text', { text: 'open location "evil"' }]
  ];
  for (const [name, args] of samples) {
    const result = await run(list, name, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.content, /script|shell|URL/i);
    assert.match(result.content, /No command was started/);
  }
  assert.equal(spawned.calls.length, 0);
  const planned = planAppControlCall('app_activate', { app: 'do shell script "id"' });
  assert.equal(planned.ok, false);
  const weird = await run(list, 'app_activate', { app: '../Cursor' });
  assert.equal(weird.ok, false);
  assert.match(weird.content, /No command was started/);
  assert.equal(spawned.calls.length, 0);
});

test('Linux and Windows return unavailable and do not spawn [AC:macos-app-control#AC-3]', async () => {
  for (const platformName of ['linux', 'win32']) {
    let spawned = false;
    const { list } = tools({
      platform: () => platformName,
      approvals: approved('app_activate', { app: 'TextEdit' }),
      spawn() { spawned = true; throw new Error('spawned'); }
    });
    for (const [name, args] of [
      ['app_activate', { app: 'TextEdit' }],
      ['app_type_text', { text: 'hello' }],
      ['app_keystroke', { key: 'return' }]
    ]) {
      const result = await run(list, name, args);
      assert.equal(result.ok, false);
      assert.match(result.content, /unavailable/i);
      assert.match(result.content, /No command was started/);
    }
    assert.equal(spawned, false);
  }
  if (process.platform !== 'darwin') {
    let spawned = false;
    const list = createAppControlTools({
      enabled: () => true,
      approvals: approved('app_activate', { app: 'TextEdit' }),
      spawn() { spawned = true; throw new Error('spawned'); }
    });
    const result = await run(list, 'app_activate', { app: 'TextEdit' });
    assert.equal(result.ok, false);
    assert.match(result.content, /unavailable/i);
    assert.match(result.content, /No command was started/);
    assert.equal(spawned, false);
  }
});

test('Lab approval is required per action and does not grant a different one [AC:macos-app-control#AC-4]', async () => {
  const { list, spawned } = tools({});
  const activate = list.find((tool) => tool.name === 'app_activate');
  assert.equal(activate.needsApproval(context, { app: 'Cursor' }), true);
  const blocked = await run(list, 'app_activate', { app: 'Cursor' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.content, /approval/i);
  assert.match(blocked.content, /No command was started/);
  assert.equal(spawned.calls.length, 0);

  const host = {
    env: {},
    appendMessage() {},
    rows: [],
    listApprovals(filter) { return this.rows.filter((row) => !filter?.status || row.status === filter.status); },
    createApproval(input) {
      const row = { id: 'ap1', status: 'pending', ...input };
      this.rows.push(row);
      return row;
    }
  };
  const gate = checkToolApprovals(host, list, [{ type: 'tool_call', toolCallId: 'c1', name: 'app_activate', input: { app: 'Cursor' } }], context, undefined, session, undefined);
  assert.equal(gate, 'waiting');
  assert.equal(spawned.calls.length, 0);

  const other = tools({ approvals: approved('app_activate', { app: 'Terminal' }) });
  const denied = await run(other.list, 'app_activate', { app: 'Cursor' });
  assert.equal(denied.ok, false);
  assert.equal(other.spawned.calls.length, 0);

  const allowed = tools({
    approvals: approvals([{
      sessionId: 's1',
      toolName: 'app_activate',
      status: 'approved',
      args: { app: 'Cursor' }
    }])
  });
  const result = await run(allowed.list, 'app_activate', { app: 'Cursor' });
  assert.equal(result.ok, true);
  assert.equal(allowed.spawned.calls.length, 1);
  assert.equal(allowed.spawned.calls[0].command, '/usr/bin/osascript');
  assert.equal(allowed.spawned.calls[0].options.shell, false);
  assert.equal(allowed.spawned.calls[0].args[0], '-e');
  assert.equal(allowed.spawned.calls[0].args[1], APP_CONTROL_SCRIPTS.activate);
  assert.equal(allowed.spawned.calls[0].args[2], 'Cursor');
  assert.equal(allowed.spawned.calls[0].args[1].includes('Cursor'), false);
  const typed = await run(allowed.list, 'app_keystroke', { key: 'return' });
  assert.equal(typed.ok, false);
  assert.equal(allowed.spawned.calls.length, 1);
});

test('keystrokes outside the small allowlist are rejected [AC:macos-app-control#AC-5]', async () => {
  const { list, spawned } = tools({ approvals: approved('app_keystroke', { key: 'f1' }) });
  for (const key of ['f1', 'cmd-q', 'command-space', 'Return', '']) {
    const result = await run(list, 'app_keystroke', { key });
    assert.equal(result.ok, false, key);
    assert.match(result.content, /return, tab, escape/);
    assert.match(result.content, /No command was started/);
  }
  assert.equal(spawned.calls.length, 0);
  const allowed = tools({
    approvals: approvals([{ sessionId: 's1', toolName: 'app_keystroke', status: 'approved', args: { key: 'cmd-v' } }])
  });
  const result = await run(allowed.list, 'app_keystroke', { key: 'cmd-v' });
  assert.equal(result.ok, true);
  assert.deepEqual(allowed.spawned.calls[0].args, ['-e', APP_CONTROL_SCRIPTS.keys['cmd-v']]);
});

test('an approved action gets a minimal env without secrets or proxies [AC:macos-app-control#AC-6]', async () => {
  const previous = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    LD_PRELOAD: process.env.LD_PRELOAD,
    HTTP_PROXY: process.env.HTTP_PROXY,
    RAW_AGENT_API_KEY: process.env.RAW_AGENT_API_KEY
  };
  process.env.NODE_OPTIONS = '--require /tmp/evil.js';
  process.env.LD_PRELOAD = '/tmp/evil.so';
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  process.env.RAW_AGENT_API_KEY = 'sk-test-secret';
  try {
    const { list, spawned } = tools({
      approvals: approvals([{ sessionId: 's1', toolName: 'app_type_text', status: 'approved', args: { text: 'Hello' } }])
    });
    const result = await run(list, 'app_type_text', { text: 'Hello' });
    assert.equal(result.ok, true);
    const env = spawned.calls[0].options.env;
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.LD_PRELOAD, undefined);
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.RAW_AGENT_API_KEY, undefined);
    assert.equal(JSON.stringify(env).includes('sk-test-secret'), false);
    assert.equal(spawned.calls[0].args[1], APP_CONTROL_SCRIPTS.typeText);
    assert.equal(spawned.calls[0].args[1].includes('Hello'), false);
    assert.equal(spawned.calls[0].args[2], 'Hello');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
