/**
 * 实验特性每一项的总闸：关掉不生效，已保存的配置还在；再打开恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activePoints,
  readJevSettings,
  resolveJevChain,
  writeJevSettings
} from '../src/jev/settings.ts';
import {
  readLangfuseSettings,
  resolveLangfuseChain,
  writeLangfuseSettings
} from '../src/langfuse/settings.ts';
import {
  planModelFallback,
  readModelFallbackSettings,
  writeModelFallbackSettings
} from '../dist/model/fallback-chain.js';
import {
  readCompactSettings,
  resolveMicroCompactConfig,
  writeCompactSettings
} from '../dist/session/compact-settings.js';
import {
  readSandboxSettings,
  resolveCloudflareComputerConfig,
  writeSandboxSettings
} from '../dist/sandbox/sandbox-settings.js';
import { resolveInboxOverflowCap } from '../dist/session/inbox-overflow.js';
import { resolveSteerDrainPolicy } from '../../agent-loop/dist/session/steer-drain.js';
import {
  appliedLoopEngine,
  readLoopSettings,
  writeLoopSettings
} from '../../../apps/daemon/src/loop-settings.ts';

function mem() {
  const map = new Map();
  return {
    getDaemonControl(key) {
      return map.get(key);
    },
    setDaemonControl(key, value) {
      map.set(key, value);
    }
  };
}

test('Jev 总闸关掉不调用且保留档位，关闭档打开后落到标准 [AC:experimental-settings#AC-5]', () => {
  const store = mem();
  writeJevSettings(store, {
    baseUrl: 'http://127.0.0.1:8008/v1/systemone',
    apiKey: 'sk-lab',
    model: 'jev-latest',
    profile: 'custom',
    points: { route: true }
  });

  writeJevSettings(store, { armed: false });
  const off = readJevSettings(store);
  assert.equal(off.armed, false);
  assert.equal(off.profile, 'custom');
  assert.equal(off.baseUrl, 'http://127.0.0.1:8008/v1/systemone');
  assert.equal(off.apiKey, 'sk-lab');
  assert.equal(off.model, 'jev-latest');
  assert.deepEqual(activePoints(off), []);
  assert.equal(resolveJevChain(store, {}), null);

  writeJevSettings(store, { armed: true });
  const back = readJevSettings(store);
  assert.equal(back.armed, true);
  assert.equal(back.profile, 'custom');
  assert.equal(back.apiKey, 'sk-lab');
  assert.deepEqual(activePoints(back), ['route']);

  writeJevSettings(store, { profile: 'mini' });
  writeJevSettings(store, { armed: false });
  assert.equal(readJevSettings(store).profile, 'mini');
  assert.deepEqual(activePoints(readJevSettings(store)), []);
  writeJevSettings(store, { armed: true });
  assert.equal(readJevSettings(store).profile, 'mini');
  assert.equal(readJevSettings(store).armed, true);

  writeJevSettings(store, { profile: 'off' });
  assert.equal(readJevSettings(store).armed, false);
  assert.equal(readJevSettings(store).profile, 'off');
  writeJevSettings(store, { armed: true });
  const opened = readJevSettings(store);
  assert.equal(opened.armed, true);
  assert.equal(opened.profile, 'normal');
  assert.equal(opened.baseUrl, 'http://127.0.0.1:8008/v1/systemone');
  assert.equal(opened.apiKey, 'sk-lab');
  assert.deepEqual(activePoints(opened), ['goalGate']);
});

test('开关关掉再打开，已保存的配置还在 [AC:experimental-settings#AC-6]', () => {
  const langfuse = mem();
  writeLangfuseSettings(langfuse, {
    baseUrl: 'http://langfuse.local',
    publicKey: 'pk',
    secretKey: 'sk',
    enabled: true
  });
  writeLangfuseSettings(langfuse, { enabled: false });
  assert.equal(readLangfuseSettings(langfuse).enabled, false);
  assert.equal(readLangfuseSettings(langfuse).baseUrl, 'http://langfuse.local');
  assert.equal(readLangfuseSettings(langfuse).publicKey, 'pk');
  assert.equal(resolveLangfuseChain(langfuse, {}), null);
  writeLangfuseSettings(langfuse, { enabled: true });
  assert.equal(readLangfuseSettings(langfuse).enabled, true);
  assert.equal(resolveLangfuseChain(langfuse, {})?.baseUrl, 'http://langfuse.local');
  writeLangfuseSettings(langfuse, { baseUrl: '', enabled: true });
  assert.equal(readLangfuseSettings(langfuse).enabled, true);
  assert.equal(resolveLangfuseChain(langfuse, { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }), null);

  const fallback = mem();
  fallback.setDaemonControl('model_fallback_settings', {
    chain: [{ providerId: 'p', modelId: 'm' }],
    updatedAt: 't'
  });
  writeModelFallbackSettings(fallback, { enabled: false }, {});
  assert.equal(readModelFallbackSettings(fallback).enabled, false);
  assert.deepEqual(readModelFallbackSettings(fallback).chain, [{ providerId: 'p', modelId: 'm' }]);
  assert.equal(planModelFallback({ store: fallback, primary: {}, env: {} }), undefined);
  writeModelFallbackSettings(fallback, { enabled: true }, {});
  assert.equal(readModelFallbackSettings(fallback).enabled, true);
  assert.deepEqual(readModelFallbackSettings(fallback).chain, [{ providerId: 'p', modelId: 'm' }]);

  const compact = mem();
  writeCompactSettings(compact, { policy: 'after_text_assistant', keepRecent: 4, enabled: true });
  writeCompactSettings(compact, { enabled: false });
  assert.equal(readCompactSettings(compact).enabled, false);
  assert.equal(readCompactSettings(compact).policy, 'after_text_assistant');
  assert.equal(readCompactSettings(compact).keepRecent, 4);
  assert.equal(
    resolveMicroCompactConfig({ store: compact, env: { RAW_AGENT_MICRO_COMPACT: '1' } }).enabled,
    false
  );
  writeCompactSettings(compact, { enabled: true });
  assert.equal(readCompactSettings(compact).policy, 'after_text_assistant');
  assert.equal(
    resolveMicroCompactConfig({ store: compact, env: { RAW_AGENT_MICRO_COMPACT: '0' } }).enabled,
    true
  );

  const sandbox = mem();
  writeSandboxSettings(sandbox, { cfEndpoint: 'https://cf.example', cfWorkspaceName: 'lab' });
  writeSandboxSettings(sandbox, { cfEnabled: false });
  assert.equal(readSandboxSettings(sandbox).cfEnabled, false);
  assert.equal(readSandboxSettings(sandbox).cfEndpoint, 'https://cf.example');
  assert.equal(readSandboxSettings(sandbox).cfWorkspaceName, 'lab');
  assert.equal(
    resolveCloudflareComputerConfig(sandbox, { CLOUDFLARE_COMPUTER_ENDPOINT: 'https://from-env.example' }).endpoint,
    ''
  );
  writeSandboxSettings(sandbox, { cfEnabled: true });
  assert.equal(readSandboxSettings(sandbox).cfEndpoint, 'https://cf.example');
  assert.equal(
    resolveCloudflareComputerConfig(sandbox, { CLOUDFLARE_COMPUTER_ENDPOINT: 'https://from-env.example' }).endpoint,
    'https://cf.example'
  );

  const loop = mem();
  writeLoopSettings(loop, {
    kernelVariant: 'ppeng',
    assemblyPreset: 'mini',
    steerDrainPolicy: 'tool_launch',
    inboxOverflowCap: 4
  });
  writeLoopSettings(loop, { engineEnabled: false });
  const saved = readLoopSettings(loop);
  assert.equal(saved.engineEnabled, false);
  assert.equal(saved.kernelVariant, 'ppeng');
  assert.equal(saved.assemblyPreset, 'mini');
  assert.equal(saved.steerDrainPolicy, 'tool_launch');
  assert.equal(saved.inboxOverflowCap, 4);
  assert.equal(resolveSteerDrainPolicy({ store: loop }), 'next_shot_only');
  assert.equal(resolveInboxOverflowCap({ store: loop }), null);
  assert.equal(appliedLoopEngine(saved).kernelVariant, 'agent-loop');
  assert.equal(appliedLoopEngine(saved).assemblyPreset, 'max');
  writeLoopSettings(loop, { engineEnabled: true });
  const reopened = readLoopSettings(loop);
  assert.equal(reopened.engineEnabled, true);
  assert.equal(reopened.kernelVariant, 'ppeng');
  assert.equal(reopened.assemblyPreset, 'mini');
  assert.equal(reopened.steerDrainPolicy, 'tool_launch');
  assert.equal(reopened.inboxOverflowCap, 4);
  assert.equal(resolveSteerDrainPolicy({ store: loop }), 'tool_launch');
  assert.equal(resolveInboxOverflowCap({ store: loop }), 4);
});
