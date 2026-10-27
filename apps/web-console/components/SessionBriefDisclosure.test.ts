import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SESSION_BRIEF_OPEN_KEY } from '../lib/session-brief.ts';
import { SessionBriefDisclosure } from './SessionBriefDisclosure.ts';

test('过程行默认收起，点开只展开这一段 [AC:session-brief#AC-8]', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      SessionBriefDisclosure,
      { label: '已收起 2 条过程', title: '点开查看这一段过程，再点一次收回' },
      React.createElement('pre', null, 'SECRET_DUMP_9f3a')
    )
  );
  assert.match(html, /^<details class="chat-process-note">/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.match(html, /<summary title="点开查看这一段过程，再点一次收回">已收起 2 条过程<\/summary>/);
  assert.match(html, /<div class="chat-process-note__body"><pre>SECRET_DUMP_9f3a<\/pre><\/div><\/details>/);
});

test('刷新后已点开的过程仍展开，没点开的仍收起 [AC:session-brief#AC-9]', () => {
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => (key === SESSION_BRIEF_OPEN_KEY ? JSON.stringify(['brief:m:a']) : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0
    }
  } as Window & typeof globalThis;
  try {
    const open = renderToStaticMarkup(
      React.createElement(SessionBriefDisclosure, { noteKey: 'brief:m:a', label: '已收起 1 条过程', title: '点开查看' }, 'SECRET_DUMP_9f3a')
    );
    const closed = renderToStaticMarkup(
      React.createElement(SessionBriefDisclosure, { noteKey: 'brief:m:b', label: '已收起 1 条过程', title: '点开查看' }, 'OTHER_SEGMENT')
    );
    assert.match(open, /<details[^>]* open/);
    assert.match(open, /SECRET_DUMP_9f3a/);
    assert.doesNotMatch(closed, /<details[^>]*\sopen/);
    assert.match(closed, /OTHER_SEGMENT/);
  } finally {
    globalThis.window = previous;
  }
});
