import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKeyFromRequest, createRateLimiter } from '../../../apps/daemon/dist/rate-limit.js';

test('untrusted forwarded addresses cannot evade rate limits [AC:ci-audit-p1-p2#AC-5]', () => {
  const limiter = createRateLimiter({ratePerSec:0.001,burst:1,idleTtlMs:300000,maxBuckets:100,trustProxy:false});
  const request = value => ({headers:{'x-forwarded-for':value},socket:{remoteAddress:'192.0.2.1'}});
  assert.equal(clientKeyFromRequest(request('203.0.113.1'),false),'192.0.2.1');
  assert.equal(limiter.take(clientKeyFromRequest(request('203.0.113.1'),false)).ok,true);
  for (const forwarded of ['203.0.113.2','203.0.113.3, 127.0.0.1',undefined,['203.0.113.4']]) {
    assert.equal(limiter.take(clientKeyFromRequest(request(forwarded),false)).ok,false);
  }
  assert.equal(clientKeyFromRequest(request('203.0.113.1, 127.0.0.1'),true),'203.0.113.1');
});
