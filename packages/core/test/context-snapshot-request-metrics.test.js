/**
 * Sent-request metrics must be readable per snapshot turn from the
 * context-snapshots payload. Older rows that were stored before a send
 * stay without those fields.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { estimateNormalRequestTokens } from '../dist/session/normal-request-budget.js';
import { recordPreparedContextSnapshot } from '../dist/session/context-snapshots.js';

const FIRST = 'FIRST_SENT_MARKER';
const SECOND = 'SECOND_SENT_MARKER';
const HISTORICAL = 'HISTORICAL_NO_SEND';

function textBody(input) {
  return (input.messages ?? [])
    .map((message) =>
      (message.parts ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
    )
    .join('\n');
}

function hasText(snapshot, marker) {
  return snapshot.blocks.some((block) => typeof block.text === 'string' && block.text.includes(marker));
}

/** Same object the GET /api/sessions/:id/context-snapshots handler returns. */
function contextSnapshotsResponse(runtime, sessionId) {
  return {
    sessionId,
    snapshots: runtime.listContextSnapshots(sessionId),
    latestRequest: runtime.store.getDaemonControl(`session.latestRequest:${sessionId}`) ?? null
  };
}

test('each sent request keeps its own tokens on that snapshot turn', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ctx-metric-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'ctx-metric-state-'));
  const sent = [];
  const adapter = {
    name: 'recording',
    contextWindow: 131072,
    inputs: sent,
    async runTurn(input) {
      sent.push(input);
      const body = textBody(input);
      const firstOnly = body.includes(FIRST) && !body.includes(SECOND);
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'ok' }],
        ...(firstOnly
          ? { usage: { inputTokens: 40, outputTokens: 1, totalTokens: 41, requests: 1 } }
          : {})
      };
    },
    async summarizeMessages() {
      return '';
    }
  };
  const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });
  let sessionId = '';
  try {
    const session = runtime.createChatSession({ title: 'metrics', message: FIRST });
    sessionId = session.id;
    recordPreparedContextSnapshot(runtime.store, {
      session,
      systemPrompt: 'HISTORICAL_SYS',
      tools: [],
      messages: [
        {
          id: 'historical',
          sessionId: session.id,
          role: 'user',
          parts: [{ type: 'text', text: HISTORICAL }],
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      adapter: { name: 'recording', contextWindow: 131072 },
      env: {}
    });

    await runtime.runSession(session.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: `${SECOND} ${'y'.repeat(2000)}` }]);
    await runtime.runSession(session.id);

    const body = contextSnapshotsResponse(runtime, session.id);
    const historical = body.snapshots.find((snapshot) => hasText(snapshot, HISTORICAL));
    const first = body.snapshots.find(
      (snapshot) => hasText(snapshot, FIRST) && !hasText(snapshot, SECOND) && typeof snapshot.estimatedTokens === 'number'
    );
    const second = body.snapshots.find(
      (snapshot) => hasText(snapshot, SECOND) && typeof snapshot.estimatedTokens === 'number'
    );
    const sentFirst = sent.filter((input) => {
      const text = textBody(input);
      return text.includes(FIRST) && !text.includes(SECOND);
    });
    const sentSecond = sent.filter((input) => textBody(input).includes(SECOND));

    assert.ok(historical, 'historical snapshot is still listed');
    assert.equal(historical.estimatedTokens, undefined);
    assert.equal(historical.windowTokens, undefined);
    assert.equal(historical.actualInputTokens, undefined);
    assert.equal(historical.sentAt, undefined);

    assert.equal(sentFirst.length >= 1, true);
    assert.equal(sentSecond.length >= 1, true);
    assert.ok(first, 'first send is readable by its snapshot turn');
    assert.ok(second, 'second send is readable by its snapshot turn');
    assert.ok(first.turn >= 1);
    assert.ok(second.turn > first.turn);

    assert.equal(first.estimatedTokens, estimateNormalRequestTokens(sentFirst.at(-1)));
    assert.equal(second.estimatedTokens, estimateNormalRequestTokens(sentSecond.at(-1)));
    assert.notEqual(first.estimatedTokens, second.estimatedTokens);
    assert.equal(first.windowTokens, 131072);
    assert.equal(second.windowTokens, 131072);
    assert.equal(first.actualInputTokens, 40);
    assert.equal(second.actualInputTokens, undefined);
    assert.equal(typeof first.sentAt, 'string');
    assert.ok(first.sentAt);
    assert.equal(typeof second.sentAt, 'string');
    assert.notEqual(first.sentAt, second.sentAt);

    assert.equal(body.latestRequest.estimatedTokens, second.estimatedTokens);
    assert.equal(body.latestRequest.windowTokens, second.windowTokens);
    assert.equal(body.latestRequest.actualInputTokens, undefined);
    assert.equal(body.latestRequest.sentAt, second.sentAt);
    assert.notEqual(body.latestRequest.estimatedTokens, first.estimatedTokens);
    assert.equal(
      body.snapshots.filter((snapshot) => hasText(snapshot, SECOND) && snapshot.estimatedTokens === first.estimatedTokens).length,
      0
    );
  } finally {
    if (sessionId) await runtime.listTraceEvents(sessionId).catch(() => undefined);
    await runtime.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
