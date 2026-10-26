import { createHash } from 'node:crypto';
export function stableJson(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableJson((value as Record<string,unknown>)[k])}`).join(',')}}`;
 return JSON.stringify(value) ?? 'null';
}
export function factFingerprint(value:unknown):string { return createHash('sha256').update(stableJson(value)).digest('hex'); }
export interface AttentionPolicy { changesOnly?:boolean;quietStart?:number;quietEnd?:number;dailyBudget?:number }
export function notificationDecision(input:{policy:AttentionPolicy;now:number;timezone:string;sentToday:number;changed:boolean}):{action:'notify'|'silent'|'digest';reason:'changed'|'unchanged'|'quiet_hours'|'budget'} {
 if(input.policy.changesOnly&&!input.changed)return {action:'silent',reason:'unchanged'};
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:input.timezone,hour:'2-digit',hourCycle:'h23'}).format(input.now));
 const {quietStart:start,quietEnd:end,dailyBudget}=input.policy;
 if(start!==undefined&&end!==undefined&&start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))return {action:'digest',reason:'quiet_hours'};
 if(dailyBudget!==undefined&&input.sentToday>=dailyBudget)return {action:'digest',reason:'budget'};
 return {action:'notify',reason:'changed'};
}
export function localNotificationDay(now:number,timezone:string):string {
 return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
