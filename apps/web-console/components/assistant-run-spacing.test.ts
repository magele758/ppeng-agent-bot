import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./sections/chat/chat.css', import.meta.url), 'utf8');
const tsx = readFileSync(new URL('./ChatTurns.tsx', import.meta.url), 'utf8');

test('省略标题时标题行脱离文档流 [AC:assistant-run-spacing#AC-1]', () => {
  assert.match(tsx, /chat-turn__label--bare/);
  assert.match(css, /\.chat-turn--continued \.chat-turn__label--bare\s*\{[^}]*position:\s*absolute[^}]*height:\s*0/);
});

test('连续助手消息间距收紧 [AC:assistant-run-spacing#AC-2]', () => {
  assert.match(tsx, /chat-turn--continued/);
  assert.match(css, /\.chat-turn--continued\s*\{\s*margin-bottom:\s*4px/);
  assert.match(css, /\.chat-turn--continued \.chat-bubble\s*\{\s*padding-top:\s*0/);
});
