import type { BotPrincipal } from '../bots/bot-identity.js';
import type { FactoryTask, FactoryMachine, FactoryReport, FactorySettings } from './types.js';
export interface DevelopmentCriterion {id:string;given:string;when:string;then:string}
export interface DevelopmentCheck {id:string;argv:string[];required:boolean}
export interface DevelopmentPolicy {
 enabled:boolean; allowedUserIds:string[]; image:string; toolPath:string; model:string;
 modelUrl:string; credentialRef:string; codeArgv:string[]; reviewArgv:string[];
 checks:DevelopmentCheck[]; redCheck:string; install:string[]; timeoutMs:number;
 maxRounds:number; maxRetries:number; minDiskMb:number; maxWorkspaceMiB?:number; criteria:DevelopmentCriterion[];
 criteriaApproved:boolean; baselineFailures:string[]; revision:string;
}
export type DevelopmentStage='QUEUED'|'WAITING_DEPENDENCY'|'START'|'RED'|'DEV'|'TEST'|'REVIEW'|'FIX'|'READY'|'WAITING_DECISION'|'PAUSED'|'DEFERRED'|'FAILED'|'CANCELLED'|'TIMED_OUT'|'VERIFYING';
export interface DevelopmentSpec {
 requirement:string; baseline:string; policy:DevelopmentPolicy; generation:number;
 stage:DevelopmentStage; round:number; delivery:'not_pushed';
 dependency?:{taskId:string;sha:string};
 reviewCarry?:{issues:unknown[];evidenceRecoveryRequired?:boolean};
 dependencyPrepared?:{generation:number;sha:string;digest:string;bytes:number;identity:string;sshAlias:string};
 decisions:{userId:string;at:string;action:string;rounds?:number;machineId?:string}[];
 executions?:{generation:number;machineId:string;repositoryId:string;status:string;result?:unknown;finishedAt?:string}[];
}
export interface DevelopmentState {
 generation:number; stage:DevelopmentStage; round:number; sha?:string;
 policyRevision?:string; manifest?:unknown; red?:unknown; checks?:unknown;
 review?:unknown; issueLedger?:unknown; timeline?:unknown[]; timelineTruncated?:boolean;
 log?:string; artifacts?:unknown; artifactsTruncated?:boolean; receiptOverflow?:boolean;
 snapshot?:unknown; evidenceRecoveryRequired?:boolean; error?:string;
}
export interface DevelopmentPreflight {ready:boolean;checks:{id:string;ok:boolean;detail:string}[]}
export interface DevelopmentHost {
 settings(p:BotPrincipal):FactorySettings; list(p:BotPrincipal):FactoryTask[];
 get(p:BotPrincipal,id:string):FactoryTask;
 enqueueDevelopment(p:BotPrincipal,input:Record<string,unknown>,spec:DevelopmentSpec):FactoryTask;
 updateDevelopment(task:FactoryTask):void;
 developmentPreflight(m:FactoryMachine,p:DevelopmentPolicy,baseline:string):Promise<DevelopmentPreflight>;
 developmentStop(t:FactoryTask,action:string):Promise<FactoryReport>;
 acceptReport(id:string,r:FactoryReport):void;
}
