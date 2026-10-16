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
  followUpToolCalls,
  formatCompactAbReport,
  isCommandReexecution,
  parseCaseList,
  parsePolicyList,
  previewCompactAbView,
  scoreRecall,
  seedMessages,
  summarizeCompactAbRuns
} from '../dist/session/compact-ab-harness.js';
import { microCompactMessages, parseToolResultStubRef } from '../dist/session/micro-compact.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';

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

test('followUpPrompt forbids re-running commands but permits history recovery', () => {
  const seed = buildCompactAbSeed({ token: FACT, caseId: 'silent' });
  const prompt = seed.followUp;
  // must NOT say "Do not use tools" (that blocked retrieve_tool_result too)
  assert.equal(prompt.includes('Do not use tools'), false);
  // must forbid re-running commands
  assert.match(prompt, /[Dd]o not re.?run|not re-run/i);
  // must permit history / transcript recovery
  assert.match(prompt, /history|transcript|session/i);
  // must still ask for the filename and only the filename
  assert.match(prompt, /tarball|filename/i);
  assert.match(prompt, /[Rr]eply with only/i);
});

test('formatCompactAbReport includes follow_up_tools when present', () => {
  const text = formatCompactAbReport({
    generatedAt: '2026-09-02T00:00:00.000Z',
    adapter: 'test',
    model: 'm',
    runs: [
      {
        policy: 'after_text_assistant',
        caseId: 'silent',
        token: FACT,
        recalled: true,
        expectedTokenInView: false,
        collapsed: 3,
        charsSaved: 700,
        viewTokens: 80,
        baselineTokens: 200,
        elapsedMs: 12,
        answerPreview: FACT,
        toolName: 'bash',
        stdoutSummary: 'ls: 18-line listing (1200ch)',
        followUpTools: ['retrieve_tool_result']
      }
    ],
    summary: summarizeCompactAbRuns([])
  });
  assert.match(text, /follow_up_tools=retrieve_tool_result/);
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

test('command re-execution is recalled=false; qualityRegression=true when keep_recent recalled', () => {
  const tok = 'ppeng-gateway-rel_reexec01.tgz';
  // Any command tool => scoreRecall returns false regardless of answer content
  for (const tool of ['bash', 'exec', 'bg_run', 'work_evidence']) {
    const result = scoreRecall({ answer: tok, token: tok, followUpTools: [tool] });
    assert.equal(result, false, `expected false for tool=${tool}`);
  }
  // Non-command tool with correct answer => recalled=true
  assert.equal(scoreRecall({ answer: tok, token: tok, followUpTools: ['retrieve_tool_result'] }), true);
  assert.equal(scoreRecall({ answer: tok, token: tok, followUpTools: [] }), true);

  // qualityRegression=true when keep_recent recalled but after_text re-executed
  const summary = summarizeCompactAbRuns([
    { policy: 'keep_recent', caseId: 'silent', token: tok, recalled: true, expectedTokenInView: true, collapsed: 0, charsSaved: 0, viewTokens: 100, baselineTokens: 100, elapsedMs: 1, answerPreview: tok },
    { policy: 'after_text_assistant', caseId: 'silent', token: tok, recalled: false, expectedTokenInView: false, collapsed: 3, charsSaved: 500, viewTokens: 50, baselineTokens: 100, elapsedMs: 1, answerPreview: '' }
  ]);
  assert.equal(summary.qualityRegression, true);
  assert.equal(summary.recalled, 1);
});

test('retrieve_tool_result / non-command follow-up with correct answer is recalled=true', () => {
  const tok = 'ppeng-gateway-rel_recall02.tgz';
  assert.equal(scoreRecall({ answer: tok, token: tok, followUpTools: ['retrieve_tool_result'] }), true);
  assert.equal(scoreRecall({ answer: tok, token: tok, followUpTools: ['history_read'] }), true);
  assert.equal(scoreRecall({ answer: tok, token: tok, followUpTools: [] }), true);
  // wrong answer => false even with non-command tools
  assert.equal(scoreRecall({ answer: 'nope', token: tok, followUpTools: ['retrieve_tool_result'] }), false);
  // isCommandReexecution helpers
  assert.equal(isCommandReexecution(['retrieve_tool_result']), false);
  assert.equal(isCommandReexecution(['bash']), true);
  assert.equal(isCommandReexecution([]), false);
});

test('followUpToolCalls ignores seeded tool calls before the follow-up message', () => {
  const seed = buildCompactAbSeed({ token: FACT, caseId: 'silent' });
  const msgs = seedMessages(seed);
  // seed has bash tool_calls; none are after the follow-up user message
  const before = followUpToolCalls(msgs, seed.followUp);
  assert.deepEqual(before, [], 'seeded bash calls must not appear');

  // append an assistant tool_call after the follow-up message
  const extra = [
    ...msgs,
    {
      id: 'a_extra',
      sessionId: 'compact-ab',
      role: 'assistant',
      parts: [{ type: 'tool_call', toolCallId: 'tc_x', name: 'retrieve_tool_result', input: {} }],
      createdAt: '2026-09-02T00:00:00.000Z'
    }
  ];
  const after = followUpToolCalls(extra, seed.followUp);
  assert.deepEqual(after, ['retrieve_tool_result']);
});


test('after_text_assistant stub carries msg=/part= and retrieve_tool_result recovers ls output', async () => {
  const seed = buildCompactAbSeed({ token: FACT, caseId: 'silent', minChars: 2400 });

  // Seed a runtime store with real messages so IDs are assigned by the store
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'cab-ret-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'cab-ret-state-')),
    modelAdapter: {
      name: 'stub',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() { return 'summary'; }
    }
  });
  const session = runtime.createChatSession({ title: 'ret-test', agentId: 'general', message: seed.firstUser });
  applyCompactAbSeedToStore(runtime.store, session.id, seed);

  // Compact the stored messages (uses store-assigned IDs) to get stubs with real msg= values
  const stored = runtime.store.foldMessages(session.id);
  const live = microCompactMessages(stored, compactAbPolicyConfig('after_text_assistant'));
  const stubParts = live.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_result'));
  assert.equal(stubParts.length, 3, 'all three tool_results must be present as stubs');

  // Parse msg=/part= from the actual stub text using parseToolResultStubRef
  const lsStub = stubParts[0];
  assert.ok(lsStub, 'first stub must exist');
  const ref = parseToolResultStubRef(lsStub.content);
  assert.ok(ref, `parseToolResultStubRef failed on: ${lsStub.content.slice(0, 80)}`);
  assert.ok(ref.messageId, 'stub must carry msg=');
  assert.equal(lsStub.content.includes(FACT), false, 'stub must not expose the token');

  // Call retrieve_tool_result with the parsed address — must recover ls output containing the token
  const tools = createBuiltinTools({
    listSessionMessages: (sid) => runtime.store.foldMessages(sid)
  });
  const retrieveTool = tools.find((t) => t.name === 'retrieve_tool_result');
  assert.ok(retrieveTool, 'retrieve_tool_result must be registered');

  const ctx = { repoRoot: process.cwd(), stateDir: process.cwd(), agent: { id: 'general' }, session: { id: session.id } };
  const byId = await retrieveTool.execute(ctx, { message_id: ref.messageId });
  assert.equal(byId.ok, true, `retrieve by id failed: ${byId.content}`);
  assert.match(byId.content, new RegExp(FACT), 'recovered content must contain the token');

  await runtime.destroy();
});
