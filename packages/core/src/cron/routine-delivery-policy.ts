import { ValidationError } from '../errors.js';
export interface RoutineDeliveryPolicy {
 comparison?:'text'|'facts';
 quietStart?:number;quietEnd?:number;dailyBudget?:number;
 inputSources:string;
 changesOnly:boolean;
 failureThreshold:number;
 approvalBeforeSend:boolean;
}
export function parseRoutineDeliveryPolicy(raw:unknown):RoutineDeliveryPolicy {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ValidationError('Invalid deliveryPolicy');
 const p=raw as Record<string,unknown>;
 if(typeof p.inputSources!=='string'||p.inputSources.length>4000)throw new ValidationError('inputSources must contain at most 4000 characters');
 if(typeof p.changesOnly!=='boolean'||typeof p.approvalBeforeSend!=='boolean')throw new ValidationError('Notification options must be boolean');
 if(typeof p.failureThreshold!=='number'||!Number.isInteger(p.failureThreshold)||p.failureThreshold<1||p.failureThreshold>100)throw new ValidationError('failureThreshold must be 1–100');
 const extra:Partial<RoutineDeliveryPolicy>={};
 if(p.comparison!==undefined){if(!['text','facts'].includes(String(p.comparison)))throw new ValidationError('Invalid comparison');extra.comparison=p.comparison as 'text'|'facts';}
 for(const key of ['quietStart','quietEnd','dailyBudget'] as const){if(p[key]===undefined)continue;const n=p[key];const max=key==='dailyBudget'?1000:23;const min=key==='dailyBudget'?1:0;if(typeof n!=='number'||!Number.isInteger(n)||n<min||n>max)throw new ValidationError('Invalid '+key);extra[key]=n;}
 if((extra.quietStart===undefined)!==(extra.quietEnd===undefined))throw new ValidationError('Both quiet hours are required');
 return {...extra,inputSources:p.inputSources.trim(),changesOnly:p.changesOnly,failureThreshold:p.failureThreshold,approvalBeforeSend:p.approvalBeforeSend};
}
