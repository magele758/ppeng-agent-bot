import {exploreConcurrencyModel,SCOPE,verifyConcurrencyRuntime,verifyConcurrencyMutations,checkConcurrencyReview,concurrencyVerdict} from './concurrency-verifier.mjs';
import {verifyRestartSuite} from './restart-worker.mjs';
try{
  const review=checkConcurrencyReview(),model=exploreConcurrencyModel();
  const negativeControls=['ownership','stale','approval'].map(fault=>({fault,result:exploreConcurrencyModel({fault})}));
  const runtime=await verifyConcurrencyRuntime(),mutations=await verifyConcurrencyMutations();
  const restart=await verifyRestartSuite();
  const existing={restart,lifecycle:restart.existing?.lifecycle??{status:'incomplete'},pairing:restart.existing?.pairing??{status:'incomplete'}};
  const report={schema:1,node:process.version,scope:SCOPE,review,model,runtime,mutations,negativeControls,existing};
  const verdict=concurrencyVerdict(report);report.status=negativeControls.some(n=>n.result.status!=='fail')&&verdict==='pass'?'fail':verdict;
  process.stdout.write(JSON.stringify(report));process.exitCode=report.status==='pass'?0:report.status==='fail'?1:2;
}catch(error){process.stdout.write(JSON.stringify({schema:1,status:'incomplete',reason:String(error.stack)}));process.exitCode=2;}
