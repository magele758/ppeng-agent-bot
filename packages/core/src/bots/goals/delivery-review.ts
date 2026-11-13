import { createHash } from 'node:crypto';
import type { KernelHookListener } from '@ppeng/agent-loop';
import { completionReport, type CompletionEvidence } from './completion-evidence.js';
import type { BotGoal, GoalReport, CriterionReview } from './types.js';

export const DELIVERY_REVIEW_PROMPT = `
Compare outcomes to the user's requested deliverables. A report that accounts for failures may fulfill a reporting request; fixing or passing those failures requires evidence when the user requested remediation. Internal waits matter only when their result changes a required deliverable. Preserve later user instructions and mandatory constraints.
Additionally return criteria, one row for every zero-based conditions index: {index,status:"fulfilled"|"open"|"blocked",refs:string[]}. Link each row to relevant recorded observations. A written answer can be evidence for a text-only deliverable.
If work remains, propose one action: proposal:{criterion,missingFact,action,impact,estimatedRequests}. State which missing fact the action tests and how its outcome changes the deliverable. Estimate the model calls for this stage alone. Reuse verified evidence; when repeated attempts have the same result, select another feasible method. If every remaining condition is blocked, cite evidence for each blocker, omit proposal and provide recovery describing the external change required to resume. Never stop solely on a forecast.`;

type Row = Record<string, unknown>;
const record = (value:unknown):value is Row => typeof value==='object' && value!==null && !Array.isArray(value);
const text = (value:unknown):value is string => typeof value==='string' && value.trim().length>0 && value.length<=1200;

function checkedRows(value:unknown, packet:CompletionEvidence): CriterionReview[] | undefined {
 if (!Array.isArray(value) || !value.length || value.length!==packet.conditions.length) return;
 const ordered = packet.conditions.map((_,i)=>value.find(row=>record(row) && row.index===i));
 const refs = new Set(packet.observations.map(item=>item.ref));
 const valid = (row:unknown):row is CriterionReview => record(row) && ['fulfilled','open','blocked'].includes(String(row.status))
   && Array.isArray(row.refs) && row.refs.every(ref=>refs.has(ref));
 if (ordered.every(valid)) return ordered.map(({index,status,refs})=>({index,status,refs:[...new Set(refs)]}));
}

function planFor(value:unknown, rows:CriterionReview[], unitCost?:number) {
 if (!record(value) || !Number.isSafeInteger(value.criterion)) return;
 const criterion=Number(value.criterion);
 if (!rows[criterion] || rows[criterion].status==='fulfilled') return;
 if (!text(value.missingFact) || !text(value.action) || !text(value.impact)) return;
 const requests=Number(value.estimatedRequests);
 const estimatedUsd=unitCost && Number.isSafeInteger(requests) && requests>0 ? unitCost*requests : undefined;
 return {criterion, missingFact:value.missingFact,action:value.action,impact:value.impact,estimatedUsd};
}

export function reviewDelivery(raw:unknown,packet:CompletionEvidence,goal:BotGoal,unitCost?:number):GoalReport {
 const legacy=completionReport(raw,packet,goal);
 if (!record(raw)) return legacy;
 const rows=checkedRows(raw.criteria,packet);
 if (!rows) return legacy;
 const original={...legacy,criteriaReview:rows};
 const unresolved=rows.filter(row=>row.status!=='fulfilled');
 if (!unresolved.length) return original;
 if (original.kind==='candidate_completed') return {...original,verified:false};
 // A later owner instruction may require a separate live action even if a criterion is blocked.
 const blocked=unresolved.every(row=>row.status==='blocked' && row.refs.length>0);
 if (blocked && !raw.proposal && text(raw.recovery) && !packet.userInstructions.length)
   return {...original,kind:'blocked',nextStep:raw.recovery,advanced:false};
 const plan=planFor(raw.proposal,rows,unitCost);
 if (!plan) return original;
 const facts=packet.observations.map(item=>JSON.stringify([item.name,item.input,item.ok,item.content]));
 const evidenceKey=createHash('sha256').update(JSON.stringify([...new Set(facts)].sort())).digest('hex');
 const repeated=goal.deliveryPlan?.evidenceKey===evidenceKey && goal.deliveryPlan.criterion===plan.criterion && goal.deliveryPlan.action===plan.action;
 return {...original,advanced:repeated?false:original.advanced,deliveryPlan:{...plan,evidenceKey},nextStep:[original.nextStep,plan.action,plan.impact].filter(Boolean).join('\n')};
}

export function repeatedToolWave() {
 let calls:string|undefined,previous:string|undefined,repeats=0;
 return (event:Parameters<KernelHookListener>[0]):boolean=>{
   if(event.type==='model_done'){
     const parts=event.assistant?.parts.filter(part=>part.type==='tool_call').map(part=>[part.name,part.input]);
     calls=parts?.length?JSON.stringify(parts):undefined;
   }
   if(event.type!=='tools_done' || !calls){return false;}
   const digest=createHash('sha256').update(calls).update(JSON.stringify(event.results)).digest('hex');
   calls=undefined;
   repeats=digest===previous?repeats+1:1;
   previous=digest;
   return repeats===3;
 };
}
