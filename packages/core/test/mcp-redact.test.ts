import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../dist/mcp/mcp-redact.js';

test('redactSecrets redacts mixed-case secret in raw, uppercase %XX, lowercase %xx, and JSON-escaped forms', () => {
  const secret = 'AbC+Def/123"Z';
  const upperPct = encodeURIComponent(secret);
  const lowerPct = upperPct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);

  assert.equal(upperPct, 'AbC%2BDef%2F123%22Z');
  assert.equal(lowerPct, 'AbC%2bDef%2f123%22Z');
  assert.notEqual(lowerPct, upperPct.toLowerCase());

  const input = [
    `raw=${secret}`,
    `upper=${upperPct}`,
    `lower=${lowerPct}`,
    `json=${jsonEscaped}`
  ].join(' | ');

  const out = redactSecrets(input, [secret]);
  assert.equal(out.includes(secret), false, 'raw secret must be redacted');
  assert.equal(out.includes(upperPct), false, 'uppercase %XX form must be redacted');
  assert.equal(out.includes(lowerPct), false, 'lowercase %xx mixed-case form must be redacted');
  assert.equal(out.includes(jsonEscaped), false, 'JSON-escaped form must be redacted');
  assert.equal(out, 'raw=[REDACTED] | upper=[REDACTED] | lower=[REDACTED] | json=[REDACTED]');
});

test('redactSecrets handles mixed-case API secret with percent-hex escapes without lowercasing letters', () => {
  const apiSecret = 'sk_' + 'live_AbC+Def/987=XyZ';
  const upperPct = encodeURIComponent(apiSecret);
  const lowerPct = upperPct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

  const out = redactSecrets(`q=${lowerPct}&u=${upperPct}&r=${apiSecret}`, [apiSecret]);
  assert.equal(out, 'q=[REDACTED]&u=[REDACTED]&r=[REDACTED]');
});

test('redactSecrets preserves non-secret text and ignores secrets shorter than 8 chars', () => {
  const out = redactSecrets('AbC+123 stays untouched for short token', ['AbC+123']);
  assert.equal(out, 'AbC+123 stays untouched for short token');
});
