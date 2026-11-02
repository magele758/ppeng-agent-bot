import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const chat = readFileSync(join(root, '../components/sections/chat/chat.css'), 'utf8');

function rule(css: string, selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector}`);
  return match[1];
}

test('[AC:chat-more-menu-on-top#AC-1] chat header stacks above the chat body', () => {
  const header = rule(chat, '.chat-panel-header');
  assert.match(header, /position:\s*relative/);
  assert.match(header, /z-index:\s*var\(--ui-z-toolbar\)/);
  assert.match(rule(chat, '.more-menu__pop'), /z-index:\s*var\(--ui-z-overlay\)/);
});

test('[AC:chat-more-menu-on-top#AC-2] more menu popup is opaque and readable', () => {
  const pop = rule(chat, '.more-menu__pop');
  assert.match(pop, /background:\s*var\(--ui-surface\)/);
  assert.match(pop, /color:\s*var\(--ui-text\)/);
  assert.doesNotMatch(pop, /glass-fill|backdrop-filter|opacity/);
  assert.doesNotMatch(rule(chat, '.more-menu__item'), /opacity/);
  assert.match(rule(chat, '.more-menu__pop .more-menu__item'), /color:\s*var\(--ui-text\)/);
  assert.match(rule(chat, '.more-menu__action:disabled'), /opacity/);
});
