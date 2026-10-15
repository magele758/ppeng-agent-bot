import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  CONTEXT_BLOCK_COLORS,
  CONTEXT_BLOCK_FALLBACK_COLOR,
  colorForContextKind,
  contextStackLegend,
  formatContextShare,
  stackContextSegments
} from './context-stack-bar.ts';

test('中英文都有上下文标签 [AC:play-context-stack#AC-1]', () => {
  assert.equal(zh.play.rail.context, '上下文');
  assert.equal(en.play.rail.context, 'Context');
  assert.notEqual(zh.play.rail.context, en.play.rail.context);
  assert.ok(zh.play.contextStack.kinds.system.length > 0);
  assert.ok(en.play.contextStack.kinds.toolStub.length > 0);
  assert.notEqual(zh.play.contextStack.kinds.memory, en.play.contextStack.kinds.memory);
  assert.notEqual(zh.play.contextStack.refresh, en.play.contextStack.refresh);
});

test('不同块种类用不同颜色，占比跟着 token 走 [AC:play-context-stack#AC-2]', () => {
  const colors = Object.values(CONTEXT_BLOCK_COLORS);
  assert.equal(new Set(colors).size, colors.length);
  assert.notEqual(colorForContextKind('system'), colorForContextKind('user'));
  assert.notEqual(colorForContextKind('memory'), colorForContextKind('working-log'));
  assert.notEqual(colorForContextKind('tool-result'), colorForContextKind('tool-stub'));
  assert.equal(colorForContextKind('not-a-kind'), CONTEXT_BLOCK_FALLBACK_COLOR);

  const stacked = stackContextSegments([
    { id: 'a', kind: 'system', tokens: 100, chars: 10, disposition: 'keep' },
    { id: 'b', kind: 'user', tokens: 300, chars: 10, disposition: 'keep' },
    { id: 'c', kind: 'tool-stub', tokens: 0, chars: 40, disposition: 'dropped' }
  ]);
  assert.equal(stacked.totalTokens, 400);
  assert.equal(stacked.segments[0].share, 0.25);
  assert.equal(stacked.segments[1].share, 0.75);
  assert.equal(stacked.segments[2].share, 0);
  assert.ok(stacked.segments[1].share > stacked.segments[0].share);
  assert.equal(stacked.segments[0].color, CONTEXT_BLOCK_COLORS.system);
  assert.equal(stacked.segments[2].disposition, 'dropped');
  const shareSum = stacked.segments.reduce((sum, segment) => sum + segment.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);

  const charsOnly = stackContextSegments([
    { id: 'a', kind: 'summary', tokens: 0, chars: 25 },
    { id: 'b', kind: 'assistant', tokens: 0, chars: 75 }
  ]);
  assert.equal(charsOnly.segments[0].share, 0.25);
  assert.equal(charsOnly.segments[1].share, 0.75);

  const legend = contextStackLegend([
    ...stackContextSegments([
      { id: 'u1', kind: 'user', tokens: 10, chars: 4 },
      { id: 'u2', kind: 'user', tokens: 30, chars: 8 },
      { id: 's', kind: 'system', tokens: 60, chars: 12 }
    ]).segments
  ]);
  assert.deepEqual(legend.map((item) => item.kind), ['user', 'system']);
  assert.equal(legend[0].tokens, 40);
  assert.equal(legend[0].share, 0.4);
  assert.equal(legend[0].color, CONTEXT_BLOCK_COLORS.user);
  assert.equal(formatContextShare(0), '0');
  assert.equal(formatContextShare(0.5), '50');
  assert.equal(formatContextShare(0.156), '15.6');
  assert.equal(formatContextShare(0.0005), '<0.1');
});
