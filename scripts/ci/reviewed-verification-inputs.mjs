// Read-only preflight: report every review drift before starting long probes.
import {checkReview} from '../formal/pairing-verifier.mjs';
import {checkLifecycleReview} from '../formal/lifecycle-verifier.mjs';
import {checkRestartReview} from '../formal/restart-verifier.mjs';
import {checkConcurrencyReview} from '../formal/concurrency-verifier.mjs';
const checks={pairing:checkReview(),lifecycle:checkLifecycleReview(),restart:checkRestartReview(),concurrency:checkConcurrencyReview()};
for(const [name,report] of Object.entries(checks)) {
  console.log(`${name}: ${report.status}${report.changed.length?': '+report.changed.join(', '):''}`);
  if(report.status!=='reviewed')process.exitCode=1;
}
