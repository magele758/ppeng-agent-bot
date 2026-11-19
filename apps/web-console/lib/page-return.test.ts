import assert from 'node:assert/strict';
import test from 'node:test';
import { onPageReturn } from './page-return.ts';

function pageTargets() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  return { win, doc };
}

test('coming back to the page refreshes once per focus or reveal, never while hidden [AC:bot-thinking-effort#AC-9]', () => {
  const { win, doc } = pageTargets();
  let refreshes = 0;
  const stop = onPageReturn(win, doc, () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 0, 'subscribing alone does not refresh');

  win.dispatchEvent(new Event('focus'));
  assert.equal(refreshes, 1);

  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 1, 'hiding the tab does not refresh');

  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 2);

  stop();
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 2, 'unsubscribed listeners stay quiet');
});
