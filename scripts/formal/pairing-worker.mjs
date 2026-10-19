import { exploreModel, verifySource, verifyMutations, checkReview, SCOPE } from './pairing-verifier.mjs';

try {
  const review = checkReview();
  const model = exploreModel();
  const negativeControls = ['missing', 'duplicate', 'misassociated'].map(fault => ({ fault, result: exploreModel({ fault }) }));
  const source = await verifySource();
  const mutations = await verifyMutations();
  const required = [...source.files, 'packages/agent-loop/src/turn/kernel.ts', 'packages/core/src/runtime/tool-loop.ts',
    'scripts/formal/pairing-verifier.mjs', 'scripts/formal/pairing-worker.mjs', 'scripts/formal/run-pairing-verification.mjs',
    'scripts/test/tool-call-pairing-verification.test.mjs', 'skills/verify-tool-call-pairing/SKILL.md'];
  const reviewedPaths = new Set(review.mapping.flatMap(row => row.files));
  const unmapped = required.filter(path => !reviewedPaths.has(path));
  if (unmapped.length) { review.status = 'needs-review'; review.unmapped = unmapped; }
  const incomplete = model.status === 'incomplete';
  const passed = review.status === 'reviewed' && model.status === 'pass' && source.status === 'pass' && mutations.status === 'pass' && negativeControls.every(x => x.result.status === 'fail');
  const status = incomplete ? 'incomplete' : passed ? 'pass' : 'fail';
  console.log(JSON.stringify({ schema: 1, status, runtime: process.version, scope: SCOPE, review, model, source, mutations, negativeControls }));
  process.exitCode = incomplete ? 2 : passed ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ schema: 1, status: 'incomplete', reason: error.message }));
  process.exitCode = 2;
}
