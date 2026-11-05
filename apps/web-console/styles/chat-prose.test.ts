import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const prose = readFileSync(join(root, 'chat-prose.css'), 'utf8');
const globals = readFileSync(join(root, '../app/globals.css'), 'utf8');

function rule(css: string, selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector}`);
  return match[1];
}

const bubble = '.lab-shell .chat-bubble__body.chat-bubble__md';

test('[AC:chat-reading#AC-2] line-height 1.7, max-width 68ch on paragraphs, h1 size 1.45em and h2 size 1.25em, heading margin 1.35em 0 0.4em', () => {
  const body = rule(prose, bubble);
  assert.match(body, /line-height:\s*1\.7/);
  assert.doesNotMatch(body, /68ch/);

  const measure = rule(prose, `${bubble} :is(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6)`);
  assert.match(measure, /max-width:\s*68ch/);
  assert.match(rule(prose, `${bubble} h1`), /font-size:\s*1\.45em/);
  assert.match(rule(prose, `${bubble} h2`), /font-size:\s*1\.25em/);
  assert.match(rule(prose, `${bubble} :is(h1, h2, h3, h4, h5, h6)`), /margin:\s*1\.35em 0 0\.4em/);
  assert.match(rule(prose, `${bubble} .chat-md-code`), /max-width:\s*none/);
  assert.match(rule(prose, `${bubble} pre`), /max-width:\s*none/);
  assert.match(rule(prose, `${bubble} .chat-md-table`), /max-width:\s*100%/);
  assert.match(rule(prose, `${bubble} table`), /max-width:\s*none/);
});

test('[AC:chat-reading#AC-3] pre max-height none (so code is not capped at half a screen) and .chat-md-code__copy exists', () => {
  assert.match(rule(prose, `${bubble} pre`), /max-height:\s*none/);
  assert.doesNotMatch(rule(prose, `${bubble} pre`), /50vh|320px/);
  assert.match(rule(prose, `${bubble} .chat-md-code__copy`), /min-height:\s*32px/);
});

test('[AC:chat-reading#AC-4] .chat-md-table overflow-x auto, th position sticky, cell padding 10px 14px', () => {
  assert.match(rule(prose, `${bubble} .chat-md-table`), /overflow-x:\s*auto/);
  assert.match(rule(prose, `${bubble} th`), /position:\s*sticky/);
  assert.match(rule(prose, `${bubble} :is(th, td)`), /padding:\s*10px 14px/);
});

test('globals.css imports chat-prose.css and keeps glass.css last', () => {
  const imports = [...globals.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const proseAt = imports.lastIndexOf('../styles/chat-prose.css');
  const glassAt = imports.lastIndexOf('../styles/glass.css');
  assert.ok(proseAt >= 0, 'chat-prose.css import missing');
  assert.equal(imports.at(-1), '../styles/glass.css');
  assert.ok(glassAt > proseAt);
});
