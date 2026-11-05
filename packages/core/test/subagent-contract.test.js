import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSubagentSummary,
  parseConfidenceFromText,
  resolveSubagentAgentId
} from '../dist/session/subagent-contract.js';

test('resolveSubagentAgentId maps roles', () => {
  assert.equal(resolveSubagentAgentId('review', 'general'), 'reviewer');
  assert.equal(resolveSubagentAgentId('evaluator', 'general'), 'evaluator');
  assert.equal(resolveSubagentAgentId(undefined, 'general'), 'general');
});

test('parseConfidenceFromText', () => {
  assert.equal(parseConfidenceFromText('confidence: 85'), 85);
  assert.equal(parseConfidenceFromText('置信度：90%'), 90);
  assert.equal(parseConfidenceFromText('no score'), undefined);
});

test('formatSubagentSummary flags low confidence for review', () => {
  const s = formatSubagentSummary({
    text: 'Looks fine.\nconfidence: 40',
    sessionId: 'sub1',
    role: 'review',
    minConfidence: 80
  });
  assert.equal(s.lowConfidence, true);
  assert.ok(s.text.includes('[low-confidence'));
});

test('formatSubagentSummary truncates', () => {
  const s = formatSubagentSummary({
    text: 'x'.repeat(100),
    sessionId: 'sub1',
    summaryMaxChars: 20
  });
  assert.equal(s.truncated, true);
  assert.ok(s.text.includes('truncated'));
  const short = formatSubagentSummary({ text: 'fits', sessionId: 'sub1', summaryMaxChars: 20 });
  assert.equal(short.truncated, undefined);
});
