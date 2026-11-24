import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import {
  detectLocalCodingAgents,
  readExternalAiSettings,
  resolveExternalAiSettings,
  writeExternalAiSettings,
  resolveEffectiveConfig
} from '../dist/index.js';

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
  }

  async runTurn(input) {
    return this.handler(input);
  }

  async summarizeMessages() {
    return 'summary';
  }
}

function makeFakeBinDir(t, names) {
  const dir = mkdtempSync(join(tmpdir(), 'coding-agent-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "CLI:${name}:CWD=$(pwd):ARGS=$*"\n`,
      'utf8'
    );
    chmodSync(file, 0o755);
  }
  return dir;
}

function withEnv(patch, fn) {
  const saved = {};
  for (const [key, val] of Object.entries(patch)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  const restore = () => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  };
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.finally(restore);
    }
    restore();
    return res;
  } catch (err) {
    restore();
    throw err;
  }
}

function makeRuntime(t, adapter) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'bot-coding-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'bot-coding-state-'));
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: adapter
  });
  t.after(async () => {
    await runtime.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { runtime, repoRoot, stateDir };
}

test('Lab 设置热开关无需环境变量或重启即可挂载与收回本机编程助手 [AC:bot-coding-agent-tools#AC-1]', async (t) => {
  const fakeBin = makeFakeBinDir(t, ['claude', 'codex']);
  await withEnv({ RAW_AGENT_EXTERNAL_AI_TOOLS: undefined, PATH: fakeBin }, async () => {
    const seenTools = [];
    const { runtime } = makeRuntime(
      t,
      new ScriptedAdapter((input) => {
        seenTools.push(input.tools.map((tool) => tool.name));
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      })
    );

    const detected = detectLocalCodingAgents(process.env);
    assert.equal(detected.find((item) => item.toolName === 'claude_code')?.installed, true);
    assert.equal(detected.find((item) => item.toolName === 'codex_exec')?.installed, true);
    assert.equal(detected.find((item) => item.toolName === 'cursor_agent')?.installed, false);

    // Before enabling in Lab, no external coding tools are registered or visible
    assert.equal(resolveExternalAiSettings(runtime.store, process.env).enabled, false);
    assert.ok(!runtime.tools.some((tool) => tool.name === 'claude_code'));

    const bot = runtime.createBot({ name: 'CodeHelper', description: 'Helps with code' });
    const opened = runtime.openBot(bot.id);
    runtime.sendUserMessage(opened.sessionId, 'round 1');
    await runtime.runSession(opened.sessionId);
    assert.ok(!seenTools[0].includes('claude_code'));

    // Enable in persisted Lab settings — no restart, no env var
    writeExternalAiSettings(runtime.store, { enabled: true });
    runtime.syncExternalAiTools();
    assert.ok(runtime.tools.some((tool) => tool.name === 'claude_code'));
    assert.equal(readExternalAiSettings(runtime.store).enabled, true);

    runtime.sendUserMessage(opened.sessionId, 'round 2');
    await runtime.runSession(opened.sessionId);
    assert.ok(seenTools[1].includes('claude_code'));
    assert.ok(seenTools[1].includes('codex_exec'));

    // Disable again — immediately revoked on next turn
    writeExternalAiSettings(runtime.store, { enabled: false });
    runtime.syncExternalAiTools();
    runtime.sendUserMessage(opened.sessionId, 'round 3');
    await runtime.runSession(opened.sessionId);
    assert.ok(!seenTools[2].includes('claude_code'));
    assert.ok(!seenTools[2].includes('codex_exec'));
  });
});

test('渐进模式下 Bot 首轮直接看到已安装的编程助手，未安装不占位，普通聊天默认隔离 [AC:bot-coding-agent-tools#AC-2]', async (t) => {
  // Install only claude and cursor-agent (testing cursor-agent fallback binary too)
  const fakeBin = makeFakeBinDir(t, ['claude', 'cursor-agent']);
  await withEnv({ RAW_AGENT_EXTERNAL_AI_TOOLS: undefined, PATH: fakeBin }, async () => {
    const observedRuns = [];
    const { runtime } = makeRuntime(
      t,
      new ScriptedAdapter((input) => {
        observedRuns.push(input.tools.map((tool) => tool.name));
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      })
    );

    // Progressive mode is the default
    writeExternalAiSettings(runtime.store, { enabled: true, allowInBotChats: true });
    runtime.syncExternalAiTools();

    // Bot chat gets installed coding agents on turn 1
    const bot = runtime.createBot({ name: 'DevBot', description: 'Engineering bot' });
    const opened = runtime.openBot(bot.id);
    runtime.sendUserMessage(opened.sessionId, 'Refactor auth module');
    await runtime.runSession(opened.sessionId);
    const botTools = observedRuns[0] ?? [];
    assert.ok(botTools.includes('claude_code'), 'installed claude_code should be visible on turn 1');
    assert.ok(botTools.includes('cursor_agent'), 'installed cursor-agent should surface cursor_agent on turn 1');
    assert.ok(!botTools.includes('codex_exec'), 'uninstalled codex_exec should not clutter turn 1');

    // Ordinary non-bot chat without session allowExternalAiTools stays isolated
    const plain = runtime.createChatSession({ title: 'plain chat', message: 'hi' });
    await runtime.runSession(plain.id);
    const plainTools = observedRuns[1] ?? [];
    assert.ok(!plainTools.includes('claude_code'), 'plain chat must remain gated without explicit opt-in');
    assert.ok(!plainTools.includes('cursor_agent'), 'plain chat must remain gated without explicit opt-in');
  });
});

test('Bot 系统上下文清晰告知已安装编程助手、偏好与深度编码委派原则，关闭或无 CLI 时不误导 [AC:bot-coding-agent-tools#AC-3]', async (t) => {
  const fakeBin = makeFakeBinDir(t, ['claude', 'codex']);
  await withEnv({ RAW_AGENT_EXTERNAL_AI_TOOLS: undefined, PATH: fakeBin }, async () => {
    const prompts = [];
    const { runtime } = makeRuntime(
      t,
      new ScriptedAdapter((input) => {
        prompts.push(input.systemPrompt);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      })
    );

    const bot = runtime.createBot({ name: 'ArchitectBot', description: 'Helps build software' });
    const opened = runtime.openBot(bot.id);

    // Disabled: must NOT inject active coding-agent installation/delegation block
    runtime.sendUserMessage(opened.sessionId, 'hello');
    await runtime.runSession(opened.sessionId);
    assert.doesNotMatch(prompts[0], /Installed local coding agents:/);

    // Enabled with preferredTool = codex_exec
    writeExternalAiSettings(runtime.store, {
      enabled: true,
      allowInBotChats: true,
      preferredTool: 'codex_exec'
    });
    runtime.syncExternalAiTools();
    runtime.sendUserMessage(opened.sessionId, 'implement a complex refactor');
    await runtime.runSession(opened.sessionId);
    const enabledPrompt = prompts[1];
    assert.match(enabledPrompt, /claude_code/);
    assert.match(enabledPrompt, /codex_exec/);
    assert.match(enabledPrompt, /preferred.*codex_exec|codex_exec.*preferred/i);
    assert.match(enabledPrompt, /deep|complex|multi-file/i);
    assert.match(enabledPrompt, /cwd|verification/i);
  });

  // Enabled, but NO CLI binaries exist on PATH: must honestly state none detected
  const emptyBin = makeFakeBinDir(t, []);
  await withEnv({ RAW_AGENT_EXTERNAL_AI_TOOLS: undefined, PATH: emptyBin }, async () => {
    let promptNoCli = '';
    const { runtime } = makeRuntime(
      t,
      new ScriptedAdapter((input) => {
        promptNoCli = input.systemPrompt;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      })
    );
    writeExternalAiSettings(runtime.store, { enabled: true, allowInBotChats: true });
    runtime.syncExternalAiTools();
    const bot = runtime.createBot({ name: 'NoCliBot', description: 'Bot on machine without CLIs' });
    const opened = runtime.openBot(bot.id);
    runtime.sendUserMessage(opened.sessionId, 'help with code');
    await runtime.runSession(opened.sessionId);
    assert.match(promptNoCli, /no supported.*detected|none detected/i);
    assert.doesNotMatch(promptNoCli, /Installed local coding agents:.*claude_code/);
  });
});

test('白名单、Bot 开关关闭、人工审批及工作区 cwd 边界约束不可绕过 [AC:bot-coding-agent-tools#AC-4]', async (t) => {
  const fakeBin = makeFakeBinDir(t, ['claude', 'cursor-agent']);
  const pathWithSh = `${fakeBin}:/bin:/usr/bin`;
  await withEnv({ RAW_AGENT_EXTERNAL_AI_TOOLS: undefined, PATH: pathWithSh }, async () => {
    let seenTools = [];
    let callMode = 'observe';
    const { runtime, repoRoot } = makeRuntime(
      t,
      new ScriptedAdapter((input) => {
        seenTools = input.tools.map((tool) => tool.name);
        const sawToolResult = input.messages.some((m) =>
          m.parts.some((p) => p.type === 'tool_result' && p.name === 'claude_code')
        );
        if (callMode === 'invoke_claude' && !sawToolResult) {
          return {
            stopReason: 'tool_use',
            assistantParts: [
              {
                type: 'tool_call',
                toolCallId: 'call_claude_1',
                name: 'claude_code',
                input: { prompt: 'fix tests', cwd: 'subpkg' }
              }
            ]
          };
        }
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      })
    );

    mkdirSync(join(repoRoot, 'subpkg'), { recursive: true });
    writeExternalAiSettings(runtime.store, { enabled: true, allowInBotChats: false });
    runtime.syncExternalAiTools();

    const bot = runtime.createBot({ name: 'GuardedBot', description: 'Guarded' });
    const opened = runtime.openBot(bot.id);

    // 1. allowInBotChats=false hides external coding agents from Bot
    runtime.sendUserMessage(opened.sessionId, 'check tools');
    await runtime.runSession(opened.sessionId);
    assert.ok(!seenTools.includes('claude_code'));

    // 2. Bot allowlist excluding claude_code still blocks it even when allowInBotChats=true
    writeExternalAiSettings(runtime.store, { enabled: true, allowInBotChats: true });
    runtime.updateBot(bot.id, { allowedTools: ['read_file', 'TodoWrite', 'load_skill', 'message_agent'] });
    runtime.sendUserMessage(opened.sessionId, 'check allowlist');
    await runtime.runSession(opened.sessionId);
    assert.ok(!seenTools.includes('claude_code'));

    // Clear allowlist -> full catalog restored
    runtime.updateBot(bot.id, { allowedTools: [] });

    // 3. Invocation requires user approval even in Bot default 'auto' permission mode
    callMode = 'invoke_claude';
    runtime.sendUserMessage(opened.sessionId, 'delegate complex fix');
    const paused = await runtime.runSession(opened.sessionId);
    assert.equal(paused.status, 'waiting_approval');
    const pending = runtime.listApprovals('pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolName, 'claude_code');

    // Approve -> executes inside valid subdirectory `subpkg`
    await runtime.approve(pending[0].id, 'approved');
    const finished = await runtime.runSession(opened.sessionId);
    assert.equal(finished.status, 'idle');
    const toolResult = runtime.store
      .listMessages(opened.sessionId)
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result' && p.name === 'claude_code');
    assert.ok(toolResult, 'claude_code should produce a tool_result after approval');
    assert.equal(toolResult.ok, true);
    assert.match(toolResult.content, /CLI:claude:CWD=.*subpkg/);

    // 4. Escaping cwd outside workspace is rejected without running CLI
    const claudeTool = runtime.tools.find((tool) => tool.name === 'claude_code');
    assert.ok(claudeTool);
    const escaped = await claudeTool.execute(
      {
        repoRoot,
        workspaceRoot: repoRoot,
        workspaceRoots: [{ alias: 'workspace', path: repoRoot, primary: true }],
        session: runtime.getSession(opened.sessionId),
        agent: runtime.store.getAgent(bot.id)
      },
      { prompt: 'read secrets', cwd: '../../etc' }
    );
    assert.equal(escaped.ok, false);
    assert.match(escaped.content, /workspace|escape|outside/i);
  });
});

test('effective config 中 Lab 持久化本机编程助手开关优先于环境变量 [AC:bot-coding-agent-tools#AC-5]', () => {
  const labOnNoEnv = resolveEffectiveConfig({
    env: {},
    lab: { externalAi: { persisted: true, enabled: true, allowInBotChats: true } },
    probes: { localBinaries: ['claude'] }
  });
  const itemOn = labOnNoEnv.items.find((i) => i.id === 'manual.externalAiTools');
  assert.equal(itemOn?.enabled, true);
  assert.equal(itemOn?.source, 'lab');

  const labOffBeatsEnv = resolveEffectiveConfig({
    env: { RAW_AGENT_EXTERNAL_AI_TOOLS: '1' },
    lab: { externalAi: { persisted: true, enabled: false, allowInBotChats: true } },
    probes: { localBinaries: ['claude', 'codex'] }
  });
  const itemOff = labOffBeatsEnv.items.find((i) => i.id === 'manual.externalAiTools');
  assert.equal(itemOff?.enabled, false);
  assert.equal(itemOff?.source, 'lab');
  assert.ok(itemOff?.hints.some((h) => h.code === 'local_binaries_detected'));
});

test('边界用例：缺失 CLI 提示已安装备选、非法 cwd 与空 prompt 被拒、cursorAgentModel 生效且敏感输出脱敏 [AC:bot-coding-agent-tools#AC-3] [AC:bot-coding-agent-tools#AC-4]', async (t) => {
  const fakeBin = makeFakeBinDir(t, ['cursor-agent']);
  const pathWithSh = `${fakeBin}:/bin:/usr/bin`;
  await withEnv(
    {
      RAW_AGENT_EXTERNAL_AI_TOOLS: undefined,
      RAW_AGENT_API_KEY: 'SUPER_SECRET_TEST_KEY_999',
      PATH: pathWithSh
    },
    async () => {
      const { runtime, repoRoot } = makeRuntime(
        t,
        new ScriptedAdapter(() => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }))
      );
      writeExternalAiSettings(runtime.store, {
        enabled: true,
        allowInBotChats: true,
        preferredTool: 'claude_code',
        cursorAgentModel: 'my-custom-model'
      });
      runtime.syncExternalAiTools();

      const bot = runtime.createBot({ name: 'EdgeBot', description: 'Edge cases' });
      const opened = runtime.openBot(bot.id);
      const ctx = {
        repoRoot,
        workspaceRoot: repoRoot,
        workspaceRoots: [{ alias: 'workspace', path: repoRoot, primary: true }],
        session: runtime.getSession(opened.sessionId),
        agent: runtime.store.getAgent(bot.id)
      };

      // Prompt notes preferred tool not on PATH, lists installed cursor_agent
      let capturedPrompt = '';
      runtime.modelAdapter = new ScriptedAdapter((input) => {
        capturedPrompt = input.systemPrompt;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      });
      runtime.sendUserMessage(opened.sessionId, 'hi');
      await runtime.runSession(opened.sessionId);
      assert.match(capturedPrompt, /claude_code.*not currently detected/i);
      assert.match(capturedPrompt, /cursor_agent/);

      const claudeTool = runtime.tools.find((tool) => tool.name === 'claude_code');
      const cursorTool = runtime.tools.find((tool) => tool.name === 'cursor_agent');
      assert.ok(claudeTool && cursorTool);

      // Empty prompt rejected
      const emptyPrompt = await claudeTool.execute(ctx, { prompt: '   ' });
      assert.equal(emptyPrompt.ok, false);

      // Missing cwd dir & file-as-cwd rejected
      const missingDir = await claudeTool.execute(ctx, { prompt: 'fix', cwd: 'does-not-exist' });
      assert.equal(missingDir.ok, false);
      assert.match(missingDir.content, /does not exist/i);

      writeFileSync(join(repoRoot, 'plain.txt'), 'hi', 'utf8');
      const fileAsCwd = await claudeTool.execute(ctx, { prompt: 'fix', cwd: 'plain.txt' });
      assert.equal(fileAsCwd.ok, false);
      assert.match(fileAsCwd.content, /not a directory/i);

      // Missing CLI (`claude` not in fakeBin) reports ENOENT cleanly with detected fallback
      const missingCli = await claudeTool.execute(ctx, { prompt: 'fix tests' });
      assert.equal(missingCli.ok, false);
      assert.match(missingCli.content, /not installed|not on PATH/i);
      assert.match(missingCli.content, /cursor_agent/);

      // cursor_agent uses cursor-agent fallback binary + Lab cursorAgentModel + redacts secrets
      const cursorRun = await cursorTool.execute(ctx, { prompt: 'echo SUPER_SECRET_TEST_KEY_999' });
      assert.equal(cursorRun.ok, true);
      assert.match(cursorRun.content, /CLI:cursor-agent:/);
      assert.match(cursorRun.content, /--model my-custom-model/);
      assert.ok(!cursorRun.content.includes('SUPER_SECRET_TEST_KEY_999'), 'secret must be redacted from CLI output');
    }
  );
});
