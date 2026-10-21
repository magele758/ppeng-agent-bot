import { ValidationError } from '../errors.js';
export interface RoutineDeliveryPolicy {
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
 return {inputSources:p.inputSources.trim(),changesOnly:p.changesOnly,failureThreshold:p.failureThreshold,approvalBeforeSend:p.approvalBeforeSend};
}
