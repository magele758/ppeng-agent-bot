import test from 'node:test';
import assert from 'node:assert/strict';
import {replayWaitCadence} from '../../../scripts/replay-agent-waits.mjs';
test('actual occurrence cadence preserves unknowns and wakes only the matching owner once [AC:durable-agent-waits#AC-7]',()=>{
 const report=replayWaitCadence();
 assert.equal(report.occurrences,826);
 assert.equal(report.routines,54);
 assert.equal(report.historicalExternalObservations,0);
 for(const scenario of report.scenarios){
  assert.equal(scenario.checks,826);
  assert.equal(scenario.resumesBeforeInjectedCompletion,0);
  assert.equal(scenario.resumesAfterInjectedCompletion,1);
  assert.equal(scenario.otherOwnersResumed,0);
  assert.equal(scenario.duplicateResumes,0);
 }
});
