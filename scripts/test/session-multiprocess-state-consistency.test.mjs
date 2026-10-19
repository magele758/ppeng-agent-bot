import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConcurrencyRuntime } from '../formal/concurrency-verifier.mjs';
const cases=['claim-A-chat','claim-B-task','contend-model-chat','handoff-end-A-task','handoff-crash-B-chat','independent-chat','stale-model-chat','stale-tool-task','stale-partial-tools-chat','release-race-chat','approval-final-foreign-chat','approval-final-foreign-task','approval-resume-approved-chat','approval-resume-mixed-task','approval-resume-rejected-chat','cancel-first-chat','decision-first-task','resume-first-chat'];
let cached;
const run=async()=>cached??=await verifyConcurrencyRuntime({only:cases});
async function check(ids,selected){const r=await run();assert.equal(r.completed,true,JSON.stringify(r));const actual=r.scenarios.filter(s=>selected.some(name=>s.name.startsWith(name))).flatMap(s=>s.checks.filter(c=>ids.includes(c.criterion)).map(c=>({scenario:s.name,...c})));assert.ok(actual.length);assert.deepEqual(actual.filter(c=>!c.ok),[]);}
test('exclusive admission and legal handoff keep unrelated work usable [AC:session-multiprocess-state-consistency#AC-1]',()=>check(['AC-1','AC-2','AC-4','AC-11'],['claim','contend','handoff','independent']));
test('stale model/tool completion and read-before-release cannot mutate successor [AC:session-multiprocess-state-consistency#AC-2]',()=>check(['AC-3','AC-5','AC-10'],['stale','release-race']));
test('concurrent foreign final decisions persist and continue atomically once [AC:session-multiprocess-state-consistency#AC-3]',()=>check(['AC-6','AC-8'],['approval-final-foreign']));
test('concurrent approval resume executes only unfinished permitted work once [AC:session-multiprocess-state-consistency#AC-4]',()=>check(['AC-8','AC-10'],['approval-resume']));
test('cancellation fences pending/final-decided/resuming approvals [AC:session-multiprocess-state-consistency#AC-5]',()=>check(['AC-9'],['cancel-first','decision-first','resume-first']));
