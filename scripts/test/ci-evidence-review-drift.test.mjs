import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

for (const [module,check] of [['lifecycle','checkLifecycleReview'],['restart','checkRestartReview'],['concurrency','checkConcurrencyReview']]) {
  test(`${module} source review includes the new trusted evidence decision [AC:ci-gate-speedup#AC-3]`,async()=>{
    const verifier=await import(`../formal/${module}-verifier.mjs`);
    const changed=verifier[check]({read:path=>readFileSync(path,'utf8')+(path.endsWith('/scripts/ci/verification-evidence.mjs')?'\n// changed evidence decision':'')});
    assert.equal(changed.status,'needs-review');
    assert.ok(changed.changed.includes('scripts/ci/verification-evidence.mjs'));
  });
}
