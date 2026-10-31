import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeHtml,
  markdownToSafeHtml,
  renderPageShareDocument,
  safeHref
} from '../src/library/page-share-html.ts';

test('escapeHtml neutralizes tags and quotes [AC:page-share-html#AC-1]', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('"x"'), '&quot;x&quot;');
});

test('markdownToSafeHtml escapes raw HTML and keeps readable text [AC:page-share-html#AC-1]', () => {
  const html = markdownToSafeHtml('# Hello\n\n<script>alert(1)</script>\n\n**bold** and `code`');
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('safeHref allows http(s)/mailto only [AC:page-share-html#AC-1]', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  const html = markdownToSafeHtml('[x](javascript:alert(1)) and [ok](https://example.com)');
  assert.match(html, />ok<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
});

test('renderPageShareDocument is a minimal read-only HTML document [AC:page-share-html#AC-2]', () => {
  const doc = renderPageShareDocument({ title: 'T <x>', markdown: 'Body **one**' });
  assert.match(doc, /<!DOCTYPE html>/);
  assert.match(doc, /<title>T &lt;x&gt;<\/title>/);
  assert.match(doc, /<h1>T &lt;x&gt;<\/h1>/);
  assert.match(doc, /<strong>one<\/strong>/);
  assert.doesNotMatch(doc, /rotate|delete|edit|settings/i);
});
