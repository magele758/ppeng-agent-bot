import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { stackContextSegments } from './context-stack-bar.ts';
import {
  buildContextReplayFrames,
  orderContextSnapshots,
  replayFrameIndex,
  selectContextReplayFrame,
  type ReplayBlock,
  type ReplaySnapshot
} from './context-stack-replay.ts';

function block(id: string, text: string, tokens: number): ReplayBlock {
  return {
    id,
    kind: 'user',
    label: '',
    text,
    tokens,
    chars: text.length,
    pinned: false,
    disposition: 'keep'
  };
}

function snap(id: string, turn: number, createdAt: string, text: string, tokens: number): ReplaySnapshot {
  return { id, turn, createdAt, blocks: [block(id, text, tokens)] };
}

test('快照按轮次排列，选中的一帧决定色条和原文 [AC:play-context-replay#AC-1] [AC:play-context-replay#AC-2]', () => {
  assert.notEqual(zh.play.contextStack.replayLive, en.play.contextStack.replayLive);
  assert.ok(zh.play.contextStack.replayAt.includes('{turn}'));
  assert.ok(en.play.contextStack.replayAt.includes('{time}'));
  assert.notEqual(zh.play.contextStack.replayEarlier, en.play.contextStack.replayEarlier);

  const shuffled = [
    snap('later', 2, '2026-04-02T00:00:00.000Z', 'SECOND', 10),
    snap('earlier-b', 1, '2026-04-01T03:00:00.000Z', 'FIRST-B', 30),
    snap('earlier-a', 1, '2026-04-01T01:00:00.000Z', 'FIRST-A', 10)
  ];
  const ordered = orderContextSnapshots(shuffled);
  assert.deepEqual(ordered.map((item) => item.id), ['earlier-a', 'earlier-b', 'later']);

  const live = [block('live-user', 'LIVE-NOW', 10), block('live-sys', 'SYSTEM', 30)];
  const frames = buildContextReplayFrames(shuffled, live);
  assert.equal(frames.at(-1)?.live, true);
  assert.equal(frames.at(-1)?.id, 'live');
  assert.deepEqual(frames.slice(0, -1).map((frame) => frame.id), ['earlier-a', 'earlier-b', 'later']);

  const oldest = selectContextReplayFrame(frames, 0);
  const current = selectContextReplayFrame(frames, frames.length - 1);
  assert.equal(oldest?.blocks[0]?.text, 'FIRST-A');
  assert.equal(current?.blocks[0]?.text, 'LIVE-NOW');
  assert.equal(selectContextReplayFrame(frames, -1), undefined);
  assert.equal(selectContextReplayFrame(frames, frames.length), undefined);
  assert.equal(replayFrameIndex(frames, 'later'), 2);
  assert.equal(replayFrameIndex(frames, 'missing'), frames.length - 1);

  const oldBar = stackContextSegments(oldest!.blocks);
  const liveBar = stackContextSegments(current!.blocks);
  assert.equal(oldBar.segments.length, 1);
  assert.equal(liveBar.segments.length, 2);
  assert.notEqual(oldBar.segments[0]?.share, liveBar.segments[0]?.share);
});
