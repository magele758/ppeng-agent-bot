import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyHumanReleaseHeader,
  copyProxyResponseHeaders,
  daemonProxyErrorMessage,
  HUMAN_RELEASE_HEADER,
  LAB_PROXY_HEADER,
  sanitizeProxyHeaders
} from './daemon-proxy.ts';

test('sanitizeProxyHeaders drops hop-by-hop and keeps content-type', () => {
  const src = new Headers({
    host: '127.0.0.1:33815',
    connection: 'keep-alive',
    'content-length': '12',
    'content-type': 'application/json',
    authorization: 'Bearer x'
  });
  const out = sanitizeProxyHeaders(src);
  assert.equal(out.get('content-type'), 'application/json');
  assert.equal(out.get('authorization'), 'Bearer x');
  assert.equal(out.get('host'), null);
  assert.equal(out.get('connection'), null);
  assert.equal(out.get('content-length'), null);
});

test('copyProxyResponseHeaders keeps set-cookie list', () => {
  const src = new Headers();
  src.append('set-cookie', 'a=1');
  src.append('set-cookie', 'b=2');
  src.set('content-type', 'application/json');
  const out = copyProxyResponseHeaders(src);
  assert.equal(out.get('content-type'), 'application/json');
  const cookies =
    typeof out.getSetCookie === 'function' ? out.getSetCookie() : [out.get('set-cookie')];
  assert.ok(cookies.some((c) => String(c).includes('a=1')));
});

test('LAB_PROXY_HEADER is the daemon isolation marker', () => {
  assert.equal(LAB_PROXY_HEADER, 'x-ppeng-lab');
});

test('human release header is attached only for same-origin Lab page fetches', () => {
  const env = { RAW_AGENT_HUMAN_RELEASE_SECRET: 'release-secret', RAW_AGENT_AUTH_TOKEN: 'operator-token' };
  const browser = new Headers({ 'sec-fetch-site': 'same-origin' });
  const outbound = new Headers();
  applyHumanReleaseHeader(browser, outbound, env);
  assert.equal(outbound.get(HUMAN_RELEASE_HEADER), 'release-secret');
  assert.equal(outbound.get('authorization'), null);

  const curl = new Headers();
  const bare = new Headers();
  applyHumanReleaseHeader(curl, bare, env);
  assert.equal(bare.get(HUMAN_RELEASE_HEADER), null);

  const spoofed = new Headers({ 'sec-fetch-site': 'cross-site' });
  const cross = new Headers();
  applyHumanReleaseHeader(spoofed, cross, env);
  assert.equal(cross.get(HUMAN_RELEASE_HEADER), null);

  const noSecret = new Headers();
  applyHumanReleaseHeader(browser, noSecret, { RAW_AGENT_AUTH_TOKEN: 'operator-token' });
  assert.equal(noSecret.get(HUMAN_RELEASE_HEADER), null);
});

test('daemonProxyErrorMessage includes cause', () => {
  const err = new Error('fetch failed');
  err.cause = new Error('other side closed');
  assert.equal(daemonProxyErrorMessage(err), 'fetch failed (other side closed)');
});
