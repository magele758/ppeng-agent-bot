import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { exploreRestartModel, SCOPE, verifyRestartRuntime, verifyRestartMutations, checkRestartReview, restartVerdict } from './restart-verifier.mjs';
import { runLifecycleProcess } from './lifecycle-verifier.mjs';
import { runVerificationProcess } from './pairing-verifier.mjs';

/** Shared unchanged suite; embedding it keeps all probes in the caller's process group. */
export async function verifyRestartSuite() {
  const review=checkRestartReview(),model=exploreRestartModel();
  const negativeControls=['running','retry','approval'].map(fault=>({fault,result:exploreRestartModel({fault})}));
  const runtime=await verifyRestartRuntime(),mutations=await verifyRestartMutations();
  const existing={pairing:runVerificationProcess(),lifecycle:runLifecycleProcess()};
  const report={schema:1,node:process.version,scope:SCOPE,review,model,runtime,mutations,negativeControls,existing};
  const verdict=restartVerdict(report);
  report.status=negativeControls.some(n=>n.result.status!=='fail')&&verdict==='pass'?'fail':verdict;
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const report=await verifyRestartSuite();
    process.stdout.write(JSON.stringify(report));process.exitCode=report.status==='pass'?0:report.status==='fail'?1:2;
  }catch(error){process.stdout.write(JSON.stringify({schema:1,status:'incomplete',reason:error.stack}));process.exitCode=2;}
}
