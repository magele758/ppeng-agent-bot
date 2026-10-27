import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVisibleClockMarks } from './visible-clock.ts';

const STAMP = '[written 2026-10-27 17:29 Asia/Shanghai]';
const BODY = '文件结构和用户消息的位置对上了。我按会话抽出今天的标题和用户原话。';

test('气泡不展示 [written … Asia/Shanghai] 这种行，正文其余部分还在 [AC:chat-bubble-written-stamp#AC-1]', () => {
  const stored = `${STAMP}\n${BODY}\n`;
  const visible = stripVisibleClockMarks(stored);
  assert.equal(stored.startsWith(STAMP), true);
  assert.equal(visible.includes('[written'), false);
  assert.equal(visible.includes('Asia/Shanghai'), false);
  assert.equal(visible.includes(BODY), true);
});

test('正文中间的写入时间和会话时钟行也不展示 [AC:chat-bubble-written-stamp#AC-2]', () => {
  const first = 'Grok 的用户原话被系统提示淹没了。我把标题补上。';
  const clock = '[conversation-clock] Current time: 2026-10-27 17:29 Tuesday (Asia/Shanghai). This is the only current date.';
  const stored = `${first}\n\n${STAMP}\n${first}\n${clock}\n收尾还在。`;
  const visible = stripVisibleClockMarks(stored);
  assert.equal(visible.includes('[written'), false);
  assert.equal(visible.includes('[conversation-clock]'), false);
  assert.equal(visible.includes('Current time:'), false);
  assert.equal(visible.split(first).length - 1, 2);
  assert.equal(visible.includes('收尾还在。'), true);
});

test('提到时区或别的方括号标记时原文还在 [AC:chat-bubble-written-stamp#AC-3]', () => {
  const stored = [
    '今天的时区是 Asia/Shanghai，不是写入标记。',
    '[routine:4090拉取ppeng并评估迁移] completed',
    '[NO_UPDATE]',
    '句子里提到 [written note] 但不是时间戳。'
  ].join('\n');
  assert.equal(stripVisibleClockMarks(stored), stored);
});

test('流式还没写完的写入时间行先不画出来 [AC:chat-bubble-written-stamp#AC-1]', () => {
  assert.equal(stripVisibleClockMarks('[written 2026-10-27 17:29 Asi'), '');
  assert.equal(stripVisibleClockMarks(`${STAMP}\n${BODY}`), BODY);
});
