import assert from 'node:assert/strict';
import test from 'node:test';
import { stripLeakedMonologue } from './leaked-monologue.ts';

const CHINESE = '先看你现有的归档里到底存了什么，再谈怎么研究。';
const ENGLISH = 'The user\'s trending archive is a fork of a JSON archive of trending repos, not full clones. I should peek at one archive JSON shape so the advice matches actual fields.';

test('精简视图去掉中文回答后面的英文独白 [AC:brief-hide-monologue#AC-1]', () => {
  const text = `${CHINESE}\n\n${ENGLISH}\n\nAdvice structure:\n\n1. Don't clone the trending list. The archive is just names and dates.`;
  assert.equal(stripLeakedMonologue(text), CHINESE);
  assert.equal(stripLeakedMonologue(`<think>${ENGLISH}</think>\n\n${CHINESE}`), CHINESE);
});

test('整段英文回答和中文里的短英文保留 [AC:brief-hide-monologue#AC-2]', () => {
  assert.equal(stripLeakedMonologue(ENGLISH), ENGLISH);
  assert.equal(stripLeakedMonologue(`${CHINESE}\n\nOK`), `${CHINESE}\n\nOK`);
});
