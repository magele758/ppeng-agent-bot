import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyProxyResponseHeaders,
  daemonProxyErrorMessage,
  HUMAN_RELEASE_HEADER,
  LAB_PROXY_HEADER,
  LAB_BROWSER_HOST_HEADER,
  sanitizeProxyHeaders,
  stripHumanReleaseHeader
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
  assert.equal(LAB_BROWSER_HOST_HEADER, 'x-ppeng-browser-host');
});

test('forged Sec-Fetch-Site does not attach a release secret, and a client header is stripped', () => {
  const src = new Headers({
    'sec-fetch-site': 'same-origin',
    authorization: 'Bearer client',
    [HUMAN_RELEASE_HEADER]: 'forged-release-secret'
  });
  const outbound = sanitizeProxyHeaders(src);
  stripHumanReleaseHeader(outbound);
  assert.equal(outbound.get('sec-fetch-site'), 'same-origin');
  assert.equal(outbound.get(HUMAN_RELEASE_HEADER), null);
  assert.equal(outbound.get('authorization'), 'Bearer client');
});

test('daemonProxyErrorMessage includes cause', () => {
  const err = new Error('fetch failed');
  err.cause = new Error('other side closed');
  assert.equal(daemonProxyErrorMessage(err), 'fetch failed (other side closed)');
});
