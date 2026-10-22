import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPS_TRACE_EVENT_LIMIT, opsTraceUrl } from './trace-page.ts';

test('[AC:ops-session-trace-repair#AC-5] ops session trace asks for the existing 5000 cap', () => {
  assert.equal(OPS_TRACE_EVENT_LIMIT, 5000);
  assert.equal(opsTraceUrl('s 1'), '/api/traces?sessionId=s%201&limit=5000');
  const src = readFileSync(new URL('../components/sections/ops/OpsSection.tsx', import.meta.url), 'utf8');
  assert.match(src, /opsTraceUrl/);
  assert.equal(src.includes('limit=500'), false);
  const route = readFileSync(new URL('../../../apps/daemon/src/routes/misc.ts', import.meta.url), 'utf8');
  assert.match(route, /listTracePage/);
  assert.match(route, /omittedEarlier: page\.omittedEarlier/);
});
