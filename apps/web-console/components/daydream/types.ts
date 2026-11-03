export interface DaydreamSettings {
    maxChunks: number;
    enabled: boolean;
    dailyAt: string;
    timezone: string;
    memoryPolicy: 'auto' | 'review';
    skillPolicy: 'propose' | 'autoPrivate';
    collaborationEnabled: boolean;
}
export interface KnowledgePolicy {
    superBotId: string;
    publishPolicy: 'review' | 'autoWithinScope';
    sharedBotIds: string[];
}
export interface SettingsResponse {
    eligibleBotIds?: string[];
    settings: DaydreamSettings;
    policy: KnowledgePolicy;
}
export interface Evidence {
    sessionId: string;
    messageId?: string;
    seq?: number;
}
export interface Output {
    conflict?: boolean;
    kind: string;
    status: string;
    summary: string;
    evidenceRefs?: Evidence[];
}
export interface Run {
    id: string;
    logicalDate: string;
    status: string;
    summary: string;
    outputs?: Output[];
}
export interface Submission {
    reviewDecision?: {action:string;reason:string};
    id: string;
    summary: string;
    reason: string;
    status: string;
}
export interface Artifact {
    id: string;
    summary?: string;
    name?: string;
    status: string;
    currentVersion: number;
}
export interface Knowledge {
    feedback?: FeedbackReview[];
    evidenceOptions?: EvidenceOption[];
    canGovern: boolean;
    submissions: Submission[];
    artifacts: Artifact[];
}

export interface EvidenceOption {sessionId:string;messageId:string;observedAt:string}

export interface FeedbackReview {id:string;artifactId:string;artifactVersion:number;description:string;status:string;originalContent:string;originalSummary:string;available:boolean;reviewDecision?:{reason:string;content?:string;summary?:string}}
