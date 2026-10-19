import { exploreLifecycleModel, verifyRuntime, verifyLifecycleMutations, checkLifecycleReview, SCOPE } from './lifecycle-verifier.mjs';
try {
  const review = checkLifecycleReview();
  const model = exploreLifecycleModel();
  const negativeControls = ['cancel', 'retry', 'approval'].map(fault => ({ fault, result: exploreLifecycleModel({ fault }) }));
  const runtime = await verifyRuntime();
  const mutations = await verifyLifecycleMutations();
  const incomplete = model.status === 'incomplete' || !runtime.completed;
  const pass = !incomplete && review.status === 'reviewed' && model.status === 'pass' && runtime.status === 'pass' && mutations.status === 'pass' && negativeControls.every(x => x.result.status === 'fail');
  const status = incomplete ? 'incomplete' : pass ? 'pass' : 'fail';
  console.log(JSON.stringify({ schema: 1, status, node: process.version, scope: SCOPE, review, model, runtime, mutations, negativeControls }));
  process.exitCode = incomplete ? 2 : pass ? 0 : 1;
} catch (error) { console.log(JSON.stringify({ schema: 1, status: 'incomplete', reason: error.message })); process.exitCode = 2; }
