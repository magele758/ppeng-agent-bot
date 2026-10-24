import { verifyEvidence } from '../agent-eval/quality-gate.mjs';
import { promoteWithSmoke } from './deploy-smoke-step.mjs';
import { appendReportEvent } from './report-builder.mjs';

/** No force flag can bypass capability evidence on the production promotion path. */
export async function promoteWithQuality(input,{verify=verifyEvidence,promote=promoteWithSmoke}={}) {
 if(!input.evidenceDir||!input.baselineSha||!input.report.candidate?.git_sha)throw Error('Promotion requires quality evidence and the stable source SHA');
 if(input.report.stable?.git_sha&&input.report.stable.git_sha!==input.baselineSha)throw Error('Declared baseline differs from recorded Stable');
 const result=verify(input.evidenceDir,{candidateSha:input.report.candidate.git_sha,baselineSha:input.baselineSha});
 appendReportEvent(input.report,'live_quality_gate',{verdict:result.verdict,baselineSha:input.baselineSha,candidateSha:input.report.candidate.git_sha});
 return promote(input);
}
