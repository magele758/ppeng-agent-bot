import { createHash } from 'node:crypto';
import type { DevelopmentPolicy } from './development-types.js';
export function policyRevision(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function newFailures(baseline:string[],current:string[]):string[]{return current.filter(x=>!baseline.includes(x));}
export function validateWorkspace(v:any){if(typeof v?.sourceBefore!=='string'||!v.sourceBefore||typeof v?.sourceAfter!=='string'||!v.sourceAfter)throw Error('Independent workspace source snapshot missing');if(!v?.independentGit||v.path===v.sourcePath||v.sourceBefore!==v.sourceAfter)throw Error('Independent isolated workspace required; source changed');return v;}
export function validateDependencies(v:any){if(v?.exitCode!==0)throw Error('Dependency install failed');if(!v.isolated)throw Error('Isolated dependencies required');return v;}
export function validateChecks(p:Pick<DevelopmentPolicy,'checks'> & {baselineFailures?:string[]},sha:string,checks:any){
 for(const c of p.checks.filter(c=>c.required)){
  const r=Array.isArray(checks)?checks.find(x=>x.id===c.id):undefined;
  if(!r||r.sha!==sha||r.passed!==true||r.skipped||!Number.isInteger(r.exitCode)||typeof r.output!=='string'||!r.output.trim())throw Error('Required check missing or wrong commit/output: '+c.id);
  if(hasSkippedChecks(r.output))throw Error('Required check contains skipped tests: '+c.id);
  if(r.exitCode!==0&&(!Array.isArray(r.failures)||!r.failures.length||r.failures.some((f:unknown)=>typeof f!=='string'||!p.baselineFailures?.includes(f))||(Array.isArray(r.newFailures)&&r.newFailures.length)))throw Error('Required check has new or environmental failure: '+c.id);
 }
 return checks;
}
function nonempty(value:unknown):value is string{return typeof value==='string'&&value.trim().length>0;}
function closureProof(issue:any,sha:unknown):boolean{return issue.closed===true&&nonempty(issue.reason)&&nonempty(issue.evidence)&&nonempty(sha)&&issue.evidenceSha===sha;}
function severityRank(severity:string):number{return ['P0','P1','P2'].indexOf(severity);}
function issueList(state:any):any[]{return [...(Array.isArray(state?.issueLedger)?state.issueLedger:[]),...(Array.isArray(state?.review?.issues)?state.review.issues:[])];}
function validIssue(issue:any):boolean{return !!issue&&nonempty(issue.id)&&['P0','P1','P2'].includes(issue.severity);}
function retainSeverity(previous:any,incoming:any){return previous&&severityRank(previous.severity)<severityRank(incoming.severity)?previous.severity:incoming.severity;}
export function mergeDevelopmentIssueLedger(previous:any,current:any):any[]{
 const sha=current.review?.sha;const ledger=new Map<string,any>();
 for(const issue of issueList(previous)){
  if(!validIssue(issue))throw Error('Invalid previous issue ledger');
  const saved={...issue,severity:retainSeverity(ledger.get(issue.id),issue)};
  if(saved.closed&&sha&&!closureProof(saved,sha))saved.closed=false;
  ledger.set(issue.id,saved);
 }
 const decisions=new Map<string,boolean>();
 for(const issue of issueList(current)){
  if(!validIssue(issue))throw Error('Invalid reported issue ledger');
  const previousIssue=ledger.get(issue.id);
  const proof=closureProof(issue,sha);
  const closed=proof&&(decisions.get(issue.id)??true);decisions.set(issue.id,closed);
  const merged={...previousIssue,...issue,severity:retainSeverity(previousIssue,issue),closed};
  ledger.set(issue.id,merged);
 }
 return [...ledger.values()];
}
export function validateReview(sha:string,r:any){
 if(!r||r.sha!==sha||!r.covered||r.verdict!=='CLEAN'||!Array.isArray(r.issues))throw Error('Incomplete review coverage or verdict');
 for(const issue of r.issues){
  if(!validIssue(issue))throw Error('Invalid review issue');
  if(issue.closed&&!closureProof(issue,sha))throw Error('Closure requires reason and current commit evidence');
  if(['P0','P1'].includes(issue.severity)&&issue.closed!==true)throw Error('Open blocking P0/P1');
 }
 return r;
}
export function verifyReady(p:DevelopmentPolicy,r:any){
 if(!r?.red||r.red.exitCode===0||r.red.reason!=='assertion'||!Array.isArray(r.red.criteria)||!p.criteria.every(c=>r.red.criteria.includes(c.id)))throw Error('Behavioral red test evidence required');
 if(!/^[a-f0-9]{40}$/.test(r.sha??'')||r.policyRevision!==p.revision||!r.clean)throw Error('READY evidence commit or policy mismatch');
 if(!Array.isArray(r.review?.files)||!r.review.files.length||!Array.isArray(r.review.segments)||!r.review.segments.length||r.review.policyRevision!==p.revision)throw Error('Complete review coverage and policy required');
 const covered=new Set<string>();for(const segment of r.review.segments){if(segment.sha!==r.sha||!Array.isArray(segment.files)||!segment.files.length||segment.policyRevision!==p.revision||segment.verdict!=='CLEAN')throw Error('Review segment coverage missing');for(const file of segment.files)covered.add(file);}
 if(covered.size!==new Set(r.review.files).size||!r.review.files.every((f:string)=>covered.has(f)))throw Error('Review files not fully covered');
 validateArtifact(r);validateWorkspace(r.manifest);validateDependencies(r.dependencies);validateChecks(p,r.sha,r.checks);validateReview(r.sha,{...r.review,issues:mergeDevelopmentIssueLedger(undefined,r)});
 if(typeof r.red.testDigest!=='string'||!r.red.testDigest||r.red.testDigest!==r.greenTestDigest)throw Error('Red and green test identity changed');return r;
}
export function nextDevelopmentAction(v:{round:number;maxRounds:number;blocking:boolean}){return !v.blocking?'READY':v.round>=v.maxRounds?'WAITING_DECISION':'FIX';}
export function retryDevelopment(attempt:number,max:number){return attempt>=max?'DEFERRED':'RETRY';}
export function validateDevelopmentPilot(rows:any[]){if(rows.length<2||new Set(rows.map(x=>x.identity)).size!==rows.length)throw Error('Two distinct physical machines required');for(const x of rows){if(!x.identity||!x.before||x.before!==x.after||!x.independent||!x.ready||!x.sha||!x.tested||!x.reviewed)throw Error('Pilot evidence changed or incomplete');}if(!rows.some(x=>x.round>0))throw Error('Actual blocking repair evidence required');return rows;}
export function validateRecoveryPilot(v:any){if(v.starts!==1||v.workspaces!==1)throw Error('Duplicate execution or workspace');if(v.occupied!==v.live)throw Error('Occupancy mismatch');return v;}

function validateArtifact(r:any){const a=r.artifact;if(!a||a.sha!==r.sha||a.baseline!==r.manifest?.baseline||!/^[a-f0-9]{64}$/.test(a.digest??'')||!Number.isInteger(a.bytes)||a.bytes<1||a.bytes>700000)throw Error('READY artifact missing or mismatched');}

function hasSkippedChecks(output:string){return output.split(/\r?\n/).some(line=>{const summary=line.match(/^\s*(?:#|ℹ)?\s*(?:skipped|todo)\s+(\d+)\s*$/i);return summary?Number(summary[1])>0:/(?:#\s*(?:SKIP|TODO)\b|\b(?:skipped|pending)\s*[:=]\s*[1-9])/i.test(line);});}
