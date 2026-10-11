import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { writeCompactSettings } from '../dist/session/compact-settings.js';
import {
  answerRecallsToken,
  applyCompactAbSeedToStore,
  buildCompactAbSeed,
  compactAbPolicyConfig,
  formatCompactAbReport,
  parseCaseList,
  parsePolicyList,
  previewCompactAbView,
  seedMessages,
  summarizeCompactAbRuns
} from '../dist/session/compact-ab-harness.js';
import { microCompactMessages } from '../dist/session/micro-compact.js';

const FACT = 'ppeng-gateway-rel_deadbeef00.tgz';

function leakSurfaces(seed) {
  return [seed.firstUser, seed.followUp, seed.command, ...seed.tools.map((t) => t.command)];
}

test('parse lists default to keep_recent + after_text / silent', () => {
  assert.deepEqual(parsePolicyList(undefined), ['keep_recent', 'after_text_assistant']);
  assert.deepEqual(parsePolicyList('after_any_assistant,keep_recent,nope'), [
    'after_any_assistant',
    'keep_recent'
  ]);
  assert.deepEqual(parseCaseList(''), ['silent']);
  assert.deepEqual(parseCaseList('silent,restated,silent'), ['silent', 'restated']);
});

test('seed uses ls / git status / test-stack stdout, not a diagnostic dump', () => {
  const seed = buildCompactAbSeed({ token: FACT, caseId: 'silent', minChars: 2400 });
  assert.equal(seed.tools.length, 3);
  assert.deepEqual(
    seed.tools.map((t) => t.kind),
    ['ls', 'git_status', 'test_stack']
  );
  assert.ok(seed.tools.every((t) => t.name === 'bash'));

  const ls = seed.tools[0];
  assert.match(ls.command, /^ls -la /);
  assert.match(ls.stdout, /^total \d+/m);
  assert.match(ls.stdout, /^drwx/m);
  assert.match(ls.stdout, /^-rw-/m);
  assert.ok(ls.stdout.includes(FACT));
  assert.match(ls.summary, /ls -la|listing/i);

  const git = seed.tools[1];
  assert.match(git.command, /^git status\b/);
  assert.match(git.stdout, /^(On branch |## )/m);
  assert.match(git.stdout, /modified:|Changes not staged/i);
  assert.equal(git.stdout.includes(FACT), false);
  assert.match(git.summary, /git status/i);

  const stack = seed.tools[2];
  assert.match(stack.command, /node --test|npm test/);
  assert.match(stack.stdout, /not ok |FAIL |AssertionError/);
  assert.match(stack.stdout, /at /);
  assert.equal(stack.stdout.includes(FACT), false);
  assert.match(stack.summary, /test|FAIL|stack/i);

  assert.equal(seed.dump.includes('SECRET_TOKEN='), false);
  assert.equal(seed.dump.includes('=== last-deploy ==='), false);
  assert.equal(seed.dump.includes('BEGIN_DUMP'), false);
  assert.ok(seed.dump.length > 2000);
  assert.ok(seed.dump.includes(FACT));
});

test('golden fact stays out of user prompts and bash command lines', () => {
  const seed = buildCompactAbSeed({ token: FACT, caseId: 'silent', minChars: 2400 });
  for (const surface of leakSurfaces(seed)) {
    assert.equal(surface.includes(FACT), false, `leaked fact into: ${surface.slice(0, 120)}`);
  }
  assert.equal(seed.consumedText.includes(FACT), false);
  assert.ok(seed.tools.some((t) => t.stdout.includes(FACT)));
});

test('silent seed: after_text drops the fact, keep_recent keeps it', () => {
  const seed = buildCompactAbSeed({ token: FACT, caseId: 'silent', minChars: 2400 });

  const keep = previewCompactAbView('keep_recent', seed);
  const afterText = previewCompactAbView('after_text_assistant', seed);
  const afterAny = previewCompactAbView('after_any_assistant', seed);

  assert.equal(keep.tokenInView, true);
  assert.equal(keep.collapsed, 0);
  assert.equal(afterText.tokenInView, false);
  assert.equal(afterText.collapsed, 3);
  assert.equal(afterAny.tokenInView, false);
  assert.equal(afterAny.collapsed, 3);
  assert.ok(afterText.charsSaved > 0);
  assert.ok(afterText.tokens < keep.tokens);

  const live = microCompactMessages(seedMessages(seed), compactAbPolicyConfig('after_text_assistant'));
  const toolResults = live.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_result'));
  assert.equal(toolResults.length, 3);
  for (const part of toolResults) {
    assert.match(part.content, /earlier tool output was omitted to save space/);
    assert.equal(part.content.includes(FACT), false);
  }
});

test('restated seed keeps the fact after after_text eviction', () => {
  const seed = buildCompactAbSeed({
    token: 'ppeng-gateway-rel_restated01.tgz',
    caseId: 'restated',
    minChars: 2400
  });
  assert.ok(seed.consumedText.includes(seed.token));
  for (const surface of leakSurfaces(seed)) {
    assert.equal(surface.includes(seed.token), false);
  }
  const afterText = previewCompactAbView('after_text_assistant', seed);
  assert.equal(afterText.collapsed, 3);
  assert.equal(afterText.tokenInView, true, 'assistant restated the fact');
});

test('answerRecallsToken and report lists tool / stdout / recall / tokens', () => {
  assert.equal(answerRecallsToken(FACT, FACT), true);
  assert.equal(answerRecallsToken(`listing has ${FACT}`, FACT), true);
  assert.equal(answerRecallsToken('nope', FACT), false);

  const summary = summarizeCompactAbRuns([
    {
      policy: 'keep_recent',
      caseId: 'silent',
      token: 'T',
      recalled: true,
      expectedTokenInView: true,
      collapsed: 0,
      charsSaved: 0,
      viewTokens: 200,
      baselineTokens: 200,
      usage: { inputTokens: 900, outputTokens: 8, totalTokens: 908, requests: 1 },
      elapsedMs: 10,
      answerPreview: 'T',
      toolName: 'bash',
      stdoutSummary:
        'ls: 18-line listing (1200ch) | git_status: short status (400ch) | test_stack: node:test FAIL (1800ch)'
    },
    {
      policy: 'after_text_assistant',
      caseId: 'silent',
      token: 'T',
      recalled: false,
      expectedTokenInView: false,
      collapsed: 3,
      charsSaved: 700,
      viewTokens: 80,
      baselineTokens: 200,
      usage: { inputTokens: 400, outputTokens: 12, totalTokens: 412, requests: 1 },
      elapsedMs: 12,
      answerPreview: 'unknown',
      toolName: 'bash',
      stdoutSummary:
        'ls: 18-line listing (1200ch) | git_status: short status (400ch) | test_stack: node:test FAIL (1800ch)'
    }
  ]);
  assert.equal(summary.qualityRegression, true);
  assert.equal(summary.completed, 2);
  assert.equal(summary.inputTokensByPolicy.keep_recent, 900);
  assert.equal(summary.inputTokensByPolicy.after_text_assistant, 400);

  const text = formatCompactAbReport({
    generatedAt: '2026-09-02T00:00:00.000Z',
    adapter: 'test',
    model: 'm',
    runs: [
      {
        policy: 'keep_recent',
        caseId: 'silent',
        token: FACT,
        recalled: true,
        expectedTokenInView: true,
        collapsed: 0,
        charsSaved: 0,
        viewTokens: 318,
        baselineTokens: 900,
        elapsedMs: 10,
        answerPreview: FACT,
        toolName: 'bash',
        stdoutSummary:
          'ls: 18-line listing (1200ch) | git_status: short status (400ch) | test_stack: node:test FAIL (1800ch)'
      }
    ],
    summary
  });
  assert.match(text, /quality_regression=true/);
  assert.match(text, /tool=bash/);
  assert.match(text, /ls: 18-line listing/);
  assert.match(text, /git_status/);
  assert.match(text, /test_stack/);
  assert.match(text, /recalled=true/);
  assert.match(text, /collapsed=0/);
  assert.match(text, /view_tok=318/);
  assert.match(text, /chars_saved=0/);
});

test('runtime follow-up sees stubbed dump under after_text, verbatim under keep_recent', async () => {
  const liveToken = 'ppeng-gateway-rel_liveview01.tgz';
  const seed = buildCompactAbSeed({ token: liveToken, caseId: 'silent', minChars: 2400 });

  async function capturedDump(policy) {
    const seen = [];
    const runtime = new RawAgentRuntime({
      repoRoot: mkdtempSync(join(tmpdir(), 'cab-repo-')),
      stateDir: mkdtempSync(join(tmpdir(), 'cab-state-')),
      modelAdapter: {
        name: 'stub',
        async runTurn(input) {
          for (const message of input.messages) {
            for (const part of message.parts) {
              if (part.type === 'tool_result') seen.push(part.content);
            }
          }
          return { stopReason: 'end', assistantParts: [{ type: 'text', text: liveToken }] };
        },
        async summarizeMessages() {
          return 'summary';
        }
      }
    });
    writeCompactSettings(runtime.store, { policy, keepRecent: policy === 'keep_recent' ? 3 : 0 });
    const session = runtime.createChatSession({
      title: `plumbing ${policy}`,
      agentId: 'general',
      message: seed.firstUser
    });
    applyCompactAbSeedToStore(runtime.store, session.id, seed);
    runtime.sendUserMessage(session.id, seed.followUp);
    await runtime.runSession(session.id);
    await runtime.destroy();
    return seen.join('\n');
  }

  const keepView = await capturedDump('keep_recent');
  const afterView = await capturedDump('after_text_assistant');
  assert.match(keepView, /rel_liveview01/);
  assert.match(afterView, /earlier tool output was omitted to save space/);
  assert.equal(afterView.includes(liveToken), false);
});
