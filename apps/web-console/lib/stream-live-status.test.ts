import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from './i18n/t.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import type { Messages } from './i18n/messages/types.ts';
import {
  charsPerSecond,
  formatLiveElapsed,
  latestPhase,
  liveLines,
  outputChars,
  pushSample,
  showLiveDots,
  snapshotLive,
  type LiveLabels,
  type LiveSample,
  type LiveSegment
} from './stream-live-status.ts';

function labelsOf(messages: Messages): LiveLabels {
  const t = (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars);
  return {
    phase: {
      waiting: t('play.live.waiting'),
      thinking: t('play.live.thinking'),
      writing: t('play.live.writing'),
      card: t('play.live.card')
    },
    tool: (name) => t('play.live.tool', { name }),
    speed: (rate) => t('play.live.speed', { rate }),
    speedNone: t('play.live.speedNone'),
    chars: (count) => t('play.live.chars', { count })
  };
}

const zhLabels = labelsOf(zh);
const enLabels = labelsOf(en);

function snap(segments: LiveSegment[], samples: LiveSample[] = [], elapsedMs = 1400) {
  return snapshotLive({ segments, startedAtMs: 1_000, nowMs: 1_000 + elapsedMs, samples });
}

test('空着的生成条显示等待和已等时间，三个点还在 [AC:stream-live-status#AC-1]', () => {
  const live = snap([]);
  const lines = liveLines(live, showLiveDots(0, 0), zhLabels);
  assert.equal(lines.phaseKey, 'waiting');
  assert.equal(lines.phase, '等待模型');
  assert.equal(lines.pace, '1.4s');
  assert.equal(lines.showDots, true);
  assert.equal(lines.speed, '还没有输出');
  assert.equal(showLiveDots(0, 2), false);
  assert.equal(formatLiveElapsed(400), '0.4s');
});

test('写字和思考时给出阶段和速度 [AC:stream-live-status#AC-2]', () => {
  const writing = snap(
    [{ kind: 'text', raw: '今天的复盘' }],
    [
      { atMs: 1_000, chars: 0 },
      { atMs: 2_000, chars: 40 }
    ],
    1000
  );
  const think = snap([{ kind: 'reasoning', text: '先看目录' }]);
  assert.equal(liveLines(writing, false, zhLabels).phase, '正在写');
  assert.equal(liveLines(writing, false, zhLabels).pace, '40 字/秒');
  assert.equal(liveLines(writing, false, zhLabels).showDots, false);
  assert.equal(liveLines(think, false, zhLabels).phase, '正在思考');
  assert.equal(liveLines(writing, false, enLabels).pace, '40 chars/s');
  assert.equal(outputChars([{ kind: 'text', raw: 'ab' }, { kind: 'reasoning', text: 'cd' }, { kind: 'tool', args: 'e' }]), 5);
});

test('调用工具时带上工具名字 [AC:stream-live-status#AC-3]', () => {
  const live = snap([
    { kind: 'reasoning', text: '要读文件' },
    { kind: 'tool', name: 'read_file', args: '{}' }
  ]);
  const lines = liveLines(live, false, zhLabels);
  assert.equal(lines.phase, '正在调用 read_file');
  assert.equal(lines.showTool, true);
  assert.equal(lines.toolName, 'read_file');
  assert.equal(latestPhase([{ kind: 'tool', name: '  ' }]).toolName, 'unknown');
  assert.equal(latestPhase([{ kind: 'tool', name: 'read_file' }, { kind: 'text', raw: '读完了' }]).phase, 'writing');
  assert.equal(latestPhase([{ kind: 'a2ui' }]).phase, 'card');
  assert.equal(liveLines(snap([{ kind: 'a2ui' }]), false, zhLabels).phase, '正在画界面');
});

test('点开后能看到已用时间、字数和速度 [AC:stream-live-status#AC-4]', () => {
  const quiet = liveLines(snap([]), true, zhLabels);
  assert.equal(quiet.elapsed, '1.4s');
  assert.equal(quiet.speed, '还没有输出');
  assert.equal(quiet.chars, '0 字');
  const flowing = liveLines(
    snap([{ kind: 'text', raw: 'hello' }], [
      { atMs: 1_200, chars: 0 },
      { atMs: 2_200, chars: 86 }
    ]),
    false,
    zhLabels
  );
  assert.equal(flowing.speed, '86 字/秒');
  assert.equal(flowing.chars, '5 字');
  assert.equal(liveLines(snap([{ kind: 'text', raw: 'hi' }]), false, enLabels).speed, 'No output yet');
});

test('速度按最近一小段计算，刚开始和停住时不乱报 [AC:stream-live-status#AC-2]', () => {
  assert.equal(charsPerSecond([{ atMs: 0, chars: 0 }], 1_000), null);
  assert.equal(
    charsPerSecond(
      [
        { atMs: 0, chars: 0 },
        { atMs: 10, chars: 100 }
      ],
      10
    ),
    null
  );
  assert.equal(
    charsPerSecond(
      [
        { atMs: 0, chars: 10 },
        { atMs: 1_000, chars: 10 }
      ],
      1_000
    ),
    0
  );
  const kept = pushSample([{ atMs: 0, chars: 3 }], 3, 100);
  assert.equal(kept.length, 1);
  const next = pushSample(kept, 8, 600);
  assert.deepEqual(next, [
    { atMs: 0, chars: 3 },
    { atMs: 600, chars: 8 }
  ]);
});

test('空白片段不算已经开始写或思考', () => {
  assert.equal(latestPhase([{ kind: 'text', raw: '   ' }, { kind: 'reasoning', text: '' }]).phase, 'waiting');
  assert.equal(formatLiveElapsed(12_500), '12s');
  assert.equal(formatLiveElapsed(Number.NaN), '0.0s');
});
