import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeHomepage } from '../lab-performance/homepage.mjs';

const times = [180, 70, 90, 20, 10, 80, 50, 40, 60, 30];
const requests = times.map(ms => ({ document: ms, auth: ms + 1, readiness: ms + 2, history: ms + 3 }));

test('real homepage probe reports P90 for ten complete HTTP rounds and medians for all six browser visits [AC:lab-performance-regression-gate#AC-1]', () => {
  const network = [
    { name: 'homepageDocumentP90Ms', value: 90 },
    { name: 'homepageAuthP90Ms', value: 91 },
    { name: 'homepageReadinessP90Ms', value: 92 },
    { name: 'homepageHistoryP90Ms', value: 93 },
    { name: 'homepageWorstRequestMs', value: 183 }
  ];
  assert.deepEqual(summarizeHomepage(requests), network);
  assert.deepEqual(summarizeHomepage(requests, { home: [230, 120, 145], bot: [301, 276, 815] }), [
    ...network, { name: 'homepageInteractiveMedianMs', value: 145 }, { name: 'botTranscriptMedianMs', value: 301 }
  ]);
});

test('partial and invalid homepage observations fail closed [AC:lab-performance-regression-gate#AC-1]', () => {
  assert.throws(() => summarizeHomepage(requests.slice(1)), /homepageDocument/);
  assert.throws(() => summarizeHomepage([...requests.slice(1), { document: 1, readiness: 1 }]), /homepageAuth/);
  assert.throws(() => summarizeHomepage([...requests.slice(1), { document: 1, auth: 1, readiness: 1 }]), /homepageHistory/);
  assert.throws(() => summarizeHomepage(requests, { home: [30, 10, 20], bot: [80, 70] }), /botTranscript/);
  assert.throws(() => summarizeHomepage(requests, { home: [30, NaN, 20], bot: [80, 70, 60] }), /homepageInteractive/);
});

test('one six-second homepage stall remains visible when P90 is fast [AC:lab-performance-regression-gate#AC-1]', () => {
  const rounds = Array.from({ length: 10 }, () => ({ document: 7, auth: 12, readiness: 9, history: 10 }));
  rounds[8].readiness = 6000;
  const find = name => summarizeHomepage(rounds).find(row => row.name === name)?.value;
  assert.equal(find('homepageReadinessP90Ms'), 9);
  assert.equal(find('homepageWorstRequestMs'), 6000);
});
