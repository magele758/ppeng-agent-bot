/**
 * Runtime-level integration: drive the actual a2ui_render tool through
 * RawAgentRuntime with a stub adapter and verify the full chain:
 *
 *   tool metadata (a2uiMessages) → SSE chunks (type: 'a2ui_message')
 *                                → SurfaceUpdatePart persisted on tool message
 *
 * Also verifies that two consecutive a2ui_render calls for the same surfaceId
 * each persist their own SurfaceUpdatePart and emit chunks (renderer-side
 * accumulation is unit-tested separately in the web-console).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { BASIC_CATALOG_ID } from '../dist/a2ui/index.js';

const ENV_KEY = 'RAW_AGENT_A2UI_ENABLED';

function makeDirs() {
  return {
    repoRoot: mkdtempSync(join(tmpdir(), 'a2ui-rt-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'a2ui-rt-state-'))
  };
}

class TwoCallA2uiAdapter {
  constructor() {
    this.name = 'two-call-a2ui';
    this.turn = 0;
  }
  async runTurn() {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        stopReason: 'tool_use',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: 'c1',
          name: 'a2ui_render',
          input: {
            surfaceId: 's1',
            catalogId: BASIC_CATALOG_ID,
            messages: [
              { createSurface: { surfaceId: 's1', catalogId: BASIC_CATALOG_ID } },
              {
                updateComponents: {
                  surfaceId: 's1',
                  components: [{ id: 'root', component: 'Text', text: 'hi' }]
                }
              }
            ]
          }
        }]
      };
    }
    if (this.turn === 2) {
      return {
        stopReason: 'tool_use',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: 'c2',
          name: 'a2ui_render',
          input: {
            surfaceId: 's1',
            messages: [{ updateDataModel: { surfaceId: 's1', value: { user: 'alice' } } }]
          }
        }]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done.' }] };
  }
  async summarizeMessages() { return ''; }
}

test('a2ui_render produces SSE chunks and SurfaceUpdatePart on the tool message', async () => {
  const prev = process.env[ENV_KEY];
  process.env[ENV_KEY] = '1';
  try {
    const { repoRoot, stateDir } = makeDirs();
    const adapter = new TwoCallA2uiAdapter();
    const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });
    rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
    const session = rt.createChatSession({ title: 'a2ui-rt' });

    const chunks = [];
    await rt.runSession(session.id, {
      onModelStreamChunk: (c) => chunks.push(c)
    });

    const a2uiChunks = chunks.filter((c) => c.type === 'a2ui_message');
    assert.equal(a2uiChunks.length, 3, `expected 3 a2ui chunks, got ${a2uiChunks.length}`);
    assert.ok(a2uiChunks.every((c) => c.surfaceId === 's1'));
    assert.ok('createSurface' in (a2uiChunks[0].envelope));
    assert.ok('updateComponents' in (a2uiChunks[1].envelope));
    assert.ok('updateDataModel' in (a2uiChunks[2].envelope));

    const messages = rt.getSessionMessages(session.id);
    const surfaceParts = [];
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.type === 'surface_update') surfaceParts.push(p);
      }
    }
    assert.equal(surfaceParts.length, 2, `expected 2 surface_update parts, got ${surfaceParts.length}`);
    assert.equal(surfaceParts[0].surfaceId, 's1');
    assert.equal(surfaceParts[0].catalogId, BASIC_CATALOG_ID);
    assert.equal(surfaceParts[0].messages.length, 2);
    assert.equal(surfaceParts[1].surfaceId, 's1');
    // Second batch lacks createSurface → empty catalogId (renderer accumulator
    // derives the live catalog from the first part).
    assert.equal(surfaceParts[1].catalogId, '');
    assert.equal(surfaceParts[1].messages.length, 1);
  } finally {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  }
});

test('a2ui tools are absent from the tool list when feature flag is off', () => {
  const prev = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  try {
    const { repoRoot, stateDir } = makeDirs();
    const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: new TwoCallA2uiAdapter() });
    const names = rt.tools.map((t) => t.name);
    assert.ok(!names.includes('a2ui_render'));
    assert.ok(!names.includes('a2ui_delete_surface'));
  } finally {
    if (prev !== undefined) process.env[ENV_KEY] = prev;
  }
});
