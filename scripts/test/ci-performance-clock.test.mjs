import test from 'node:test';
import assert from 'node:assert/strict';
import { bestCpuMs } from '../../packages/core/test/helpers/timing.js';

test('synchronous performance contracts charge the executing thread rather than loader-worker CPU [AC:ci-gate-speedup#AC-6]', () => {
  const processClock=process.cpuUsage, threadClock=process.threadCpuUsage;
  try {
    process.cpuUsage = start => ({user:start?99000:1000000,system:0});
    process.threadCpuUsage = start => ({user:start?1000:10000,system:0});
    let calls=0;
    const measured=bestCpuMs(()=>++calls);
    assert.equal(measured.ms,1);
    assert.equal(calls,3);
    assert.equal(measured.result,3);
    process.threadCpuUsage = start => ({user:start?14000:10000,system:0});
    assert.equal(bestCpuMs(()=>undefined).ms,14,'expensive synchronous work remains fully charged');
  } finally {process.cpuUsage=processClock;process.threadCpuUsage=threadClock;}
});

test('older supported Node versions retain the process CPU fallback [AC:ci-gate-speedup#AC-6]', () => {
  const processClock=process.cpuUsage,threadClock=process.threadCpuUsage;
  try {
    process.threadCpuUsage=undefined;
    process.cpuUsage=start=>({user:start?2000:10000,system:0});
    assert.equal(bestCpuMs(()=>undefined).ms,2);
  } finally {process.cpuUsage=processClock;process.threadCpuUsage=threadClock;}
});
