import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';
export type Fact = string | number | boolean | null;
export type WaitCondition =
 | {op:'eq'|'ne'|'gte'|'lte';field:string;value:Fact}
 | {op:'in';field:string;values:Fact[]}
 | {op:'changed';field:string}
 | {op:'all'|'any';conditions:WaitCondition[]};
export interface WaitSpec { source:string;ref:string;condition:WaitCondition;deadline?:number;maxChecks?:number }
export interface WaitOwner { kind:'goal'|'routine';id:string;revision:number;sessionId:string;scopeSessionId:string;executionId?:string;botId?:string }
export type Observation = {availability:'available';facts:Record<string,Fact>} | {availability:'unavailable'|'unauthorized';reason:string};
export interface WaitSource {
 fields:readonly string[];
 /** Trusted host adapter; must reauthorize the resource on every read. No model calls. */
 observe(context:{store:SqliteStateStore;owner:WaitOwner;session:SessionRecord;scope:SessionRecord},ref:string):Observation;
}
export interface DurableWait {
 id:string;owner:WaitOwner;principal:string;spec:WaitSpec;
 status:'waiting'|'blocked'|'ready'|'consumed'|'expired'|'cancelled';
 baseline?:Record<string,Fact>;observation?:Observation;reason?:string;checks:number;createdAt:number;updatedAt:number;/** Host registered without a wait_for tool wave. */hostRegistered?:boolean;
}
