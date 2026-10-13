import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReleaseEvidence } from '../bot-release/evidence.mjs';
test('incomplete or mismatched candidate evidence cannot authorize release [AC:bot-release-readiness#AC-3]',()=>{
 const empty=assessReleaseEvidence({candidate:'candidate-a',checks:[]});
 assert.equal(empty.ready,false);assert.ok(empty.missing.includes('soak'));assert.ok(empty.missing.includes('live-model'));
 const wrong=assessReleaseEvidence({candidate:'candidate-a',checks:[{gate:'soak',candidate:'candidate-b',status:'passed',durationSeconds:86400}]});
 assert.equal(wrong.ready,false);assert.ok(wrong.missing.includes('soak'));
 const smoke=assessReleaseEvidence({candidate:'candidate-a',checks:[{gate:'soak',candidate:'candidate-a',status:'passed',durationSeconds:60,artifact:'smoke.json'}]});
 assert.equal(smoke.ready,false);assert.ok(smoke.missing.includes('soak'));
});
