import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { externalAiRoutes } from '../dist/routes/external-ai.js';

function fixture(t, env: NodeJS.ProcessEnv = {}) {
  const values = new Map<string, unknown>();
  let synced = 0;
  const store = {
    getDaemonControl: <T>(key: string) => values.get(key) as T | undefined,
    setDaemonControl: (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
  const runtime = {
    store,
    syncExternalAiTools() {
      synced += 1;
    }
  };
  const routes = externalAiRoutes(runtime as never, env);
  const call = async (method: 'GET' | 'PATCH', body?: unknown) => {
    let text = '';
    const response = {
      statusCode: 0,
      setHeader() {},
      end(chunk?: string) {
        text = chunk ?? '';
      }
    };
    const route = routes.find((item) => item.method === method)!;
    await route.handler({ response, readBody: async () => body } as never);
    return { status: response.statusCode, body: JSON.parse(text) };
  };
  return { call, values, syncCount: () => synced };
}

test('daemon 接口读写本机编程助手设置、返回本机 CLI 检测并拒绝非法值 [AC:bot-coding-agent-tools#AC-1] [AC:bot-coding-agent-tools#AC-5]', async (t) => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'daemon-ext-ai-bin-'));
  t.after(() => rmSync(fakeBin, { recursive: true, force: true }));
  for (const bin of ['claude', 'codex']) {
    const file = join(fakeBin, bin);
    writeFileSync(file, '#!/bin/sh\necho ok\n', 'utf8');
    chmodSync(file, 0o755);
  }

  const { call, values, syncCount } = fixture(t, { PATH: fakeBin });

  const fresh = await call('GET');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.settings.enabled, false);
  assert.equal(fresh.body.settings.allowInBotChats, true);
  assert.equal(fresh.body.settings.preferredTool, 'auto');
  assert.equal(fresh.body.effective.source, 'default');
  assert.equal(fresh.body.effective.detectedAgents.find((a: { toolName: string }) => a.toolName === 'claude_code')?.installed, true);
  assert.equal(fresh.body.effective.detectedAgents.find((a: { toolName: string }) => a.toolName === 'codex_exec')?.installed, true);
  assert.equal(fresh.body.effective.detectedAgents.find((a: { toolName: string }) => a.toolName === 'cursor_agent')?.installed, false);

  const saved = await call('PATCH', {
    enabled: true,
    allowInBotChats: true,
    preferredTool: 'codex_exec',
    cursorAgentModel: 'composer-2'
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.enabled, true);
  assert.equal(saved.body.settings.preferredTool, 'codex_exec');
  assert.equal(saved.body.settings.cursorAgentModel, 'composer-2');
  assert.equal(saved.body.effective.source, 'lab');
  assert.equal(syncCount(), 1, 'saving triggers runtime hot-sync');
  assert.equal(values.size, 1, 'persisted in daemon_control');

  for (const bad of [
    { enabled: 'yes' },
    { allowInBotChats: 1 },
    { preferredTool: 'unknown_cli' },
    { cursorAgentModel: 'has space' },
    { unexpectedKey: true }
  ]) {
    await assert.rejects(call('PATCH', bad), /Invalid|Unknown|Only|boolean|preferredTool|cursorAgentModel/i, JSON.stringify(bad));
  }

  const afterBad = await call('GET');
  assert.equal(afterBad.body.settings.enabled, true, 'rejected save must not overwrite saved settings');
  assert.equal(afterBad.body.settings.preferredTool, 'codex_exec');

  const policy = readFileSync(new URL('../src/access/policy.ts', import.meta.url), 'utf8');
  assert.match(policy, /\['GET \/api\/external-ai\/settings', AUTHENTICATED\]/);
  assert.match(policy, /\['PATCH \/api\/external-ai\/settings', ADMIN\]/);
  assert.match(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'), /externalAiRoutes\(runtime/);
});
