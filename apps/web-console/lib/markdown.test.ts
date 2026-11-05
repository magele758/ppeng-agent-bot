import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

function paragraphBodies(html: string): string[] {
  return [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1]);
}

test('blank markdown renders nothing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('  \n\t'), '');
});

test('blank line splits paragraphs and a single newline does not emit br [AC:chat-reading#AC-1]', () => {
  const split = renderMarkdown('First paragraph.\n\nSecond paragraph.');
  const bodies = paragraphBodies(split);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0] ?? '', /First paragraph\./);
  assert.match(bodies[1] ?? '', /Second paragraph\./);
  assert.equal(split.includes('<br'), false);

  const soft = renderMarkdown('Same line\nstill the same paragraph.');
  const softBodies = paragraphBodies(soft);
  assert.equal(softBodies.length, 1);
  assert.match(softBodies[0] ?? '', /Same line/);
  assert.match(softBodies[0] ?? '', /still the same paragraph\./);
  assert.equal(soft.includes('<br'), false);
});

test('fenced typescript block has a language label and an empty copy button [AC:chat-reading#AC-3]', () => {
  const html = renderMarkdown('```typescript\nconst answer = 1 < 2;\n```');
  assert.match(html, /<span class="chat-md-code__lang">typescript<\/span>/);
  assert.match(html, /<button type="button" class="chat-md-code__copy" data-md-copy><\/button>/);
  assert.match(html, /<code class="language-typescript">const answer = 1 &lt; 2;/);
  assert.equal(html.includes('1 < 2'), false);

  const plain = renderMarkdown('```\nplain()\n```');
  assert.match(plain, /<span class="chat-md-code__lang"><\/span>/);
  assert.match(plain, /<button type="button" class="chat-md-code__copy" data-md-copy><\/button>/);
  assert.match(plain, /<pre><code>plain\(\)/);
  assert.equal(plain.includes('language-'), false);
});

test('a gfm table sits inside one chat-md-table frame [AC:chat-reading#AC-4]', () => {
  const html = renderMarkdown('| Name | Value |\n| --- | --- |\n| alpha | beta |');
  assert.match(html, /<div class="chat-md-table"><table>[\s\S]*alpha[\s\S]*beta[\s\S]*<\/table>\s*<\/div>/);
  assert.equal(html.match(/chat-md-table/g)?.length, 1);
});

test('links open in a new tab and script or javascript hrefs do not run [AC:chat-reading#AC-6]', () => {
  const html = renderMarkdown('See [docs](https://example.com).\n<script>alert(1)</script>');
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('&lt;script'), true);

  const bad = renderMarkdown('[click](javascript:alert(1))');
  assert.equal(/href\s*=\s*["']\s*javascript:/i.test(bad), false);
  assert.match(bad, /click/);

  const mixed = renderMarkdown('[click](JavaScript:alert(1))');
  assert.equal(/href\s*=\s*["']\s*javascript:/i.test(mixed), false);

  const doc = renderMarkdown('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
  assert.equal(doc.includes('<script'), false);
  assert.equal(doc.includes('&lt;script'), true);

  const image = renderMarkdown('![x](javascript:alert(1))');
  assert.equal(/src\s*=\s*["']\s*javascript:/i.test(image), false);

  const file = renderMarkdown('[foo](./src/foo.ts)');
  assert.match(file, /<a href="\.\/src\/foo\.ts" target="_blank" rel="noopener noreferrer">foo<\/a>/);
});
