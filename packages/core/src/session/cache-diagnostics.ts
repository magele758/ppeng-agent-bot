import { factFingerprint } from '../cron/notification-decision.js';
export interface CacheDiagnostic {at:string;fingerprints:Record<string,string>;changed:string[];cachedInputTokens:number|null;inputTokens:number|null}
export function diagnosePrompt(previous:CacheDiagnostic|undefined,sections:{system:string;tools:unknown;stable:string},cachedInputTokens?:number,inputTokens?:number):CacheDiagnostic {
 const fingerprints=Object.fromEntries(Object.entries(sections).map(([key,value])=>[key,factFingerprint(value)]));
 return {at:new Date().toISOString(),fingerprints,changed:previous?Object.keys(fingerprints).filter(k=>previous.fingerprints[k]!==fingerprints[k]):[],cachedInputTokens:typeof cachedInputTokens==='number'&&Number.isFinite(cachedInputTokens)?cachedInputTokens:null,inputTokens:typeof inputTokens==='number'&&Number.isFinite(inputTokens)?inputTokens:null};
}
