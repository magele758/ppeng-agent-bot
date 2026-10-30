import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tsx = readFileSync(new URL('./ChatTurns.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

test('助手按钮在气泡之后的 actions 行 [AC:assistant-actions-at-end#AC-1]', () => {
  assert.match(tsx, /<\/div>\n\s*\{r === 'assistant' \? <div className="chat-turn__actions">\{actions\}<\/div> : null\}/);
  assert.match(tsx, /actions=\{r === 'assistant' \? null : actions\}/);
  assert.match(css, /\.chat-turn__actions\s*\{[^}]*display:\s*flex/);
});

test('无内容的省略标题行不渲染 [AC:assistant-actions-at-end#AC-2]', () => {
  assert.match(tsx, /if \(bare && !steer && cronName === null && !actions\) return null;/);
});

test('非助手角色按钮仍在标题行 [AC:assistant-actions-at-end#AC-3]', () => {
  assert.match(tsx, /\{text\}\n\s*\{actions\}\n\s*<TurnTags/);
});
