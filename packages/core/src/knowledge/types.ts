import type { DatabaseSync } from "node:sqlite";
export interface KnowledgeActor {
  tenantId: string;
  scopeId: string;
  botId: string;
  admin?: boolean;
}
export interface KnowledgeRef {
  id: string;
  version: number;
  kind: "memory" | "skill";
}
export interface KnowledgeEvidence {
  sessionId: string;
  messageId: string;
  observedAt: string;
}
export interface KnowledgePolicy {
  superBotId: string;
  allowedRecipientBotIds: string[];
  publishPolicy: "review" | "autoWithinScope";
}
export interface SubmissionInput {
  sourceRunId: string;
  kind: "memory" | "skill";
  localArtifact: KnowledgeRef;
  content: string;
  summary: string;
  reason: string;
  evidenceRefs: KnowledgeEvidence[];
  recipientBotIds: string[];
  derivedFrom?: KnowledgeRef[];
  targetSharedId?: string;
  publicationMode?: "reference" | "curated";
}
export interface KnowledgeSubmission extends SubmissionInput {
  reviewDecision?: KnowledgeDecision;
  awaitingScope?: boolean;
  id: string;
  tenantId: string;
  scopeId: string;
  sourceBotId: string;
  createdAt: string;
  status: "pending" | "accepted" | "merged" | "rejected" | "needsEvidence";
  decisionReason?: string;
  publishedArtifact?: KnowledgeRef;
}
export interface SharedKnowledge {
  id: string;
  tenantId: string;
  scopeId: string;
  kind: "memory" | "skill";
  version: number;
  content: string;
  summary: string;
  contentRef: KnowledgeRef;
  evidenceRefs: KnowledgeEvidence[];
  contributorBotIds: string[];
  recipientBotIds: string[];
  stewardBotId: string;
  publicationMode: "reference" | "curated";
  derivedFrom?: KnowledgeRef[];
  feedbackIds?: string[];
  status: "active" | "disputed" | "retired";
  createdAt: string;
}
export interface KnowledgeDecision {
  action: "publish" | "reject" | "needsEvidence";
  reason: string;
  expectedVersion?: number;
}
export interface FeedbackInput {
  artifactId: string;
  artifactVersion: number;
  kind: "verified" | "failed" | "correction" | "extension";
  description: string;
  evidenceRefs: KnowledgeEvidence[];
}
export interface FeedbackDecision {
  action: "revise" | "dismiss";
  reason: string;
  expectedVersion?: number;
  content?: string;
  summary?: string;
}
export interface KnowledgeFeedback extends FeedbackInput {
  reviewDecision?: FeedbackDecision;
  id: string;
  fromBotId: string;
  decisionReason?: string;
  resolvedArtifact?: KnowledgeRef;
  status: "pending" | "resolved" | "dismissed";
  createdAt: string;
}
export interface KnowledgeBatch {
  id: string;
  submissionIds: string[];
  feedbackIds: string[];
  createdAt: string;
}
export interface KnowledgeEvent {
  seq: number;
  artifactId: string;
  version: number;
  type: "published" | "updated" | "revoked";
  createdAt: string;
}
export interface KnowledgeDeps {
  db: DatabaseSync;
  isBotInScope: (tenantId: string, scopeId: string, botId: string) => boolean;
  /** Trusted host validates message ownership and a persisted artifact version; never supplied by model. */
  validateSubmission: (
    actor: KnowledgeActor,
    input: SubmissionInput,
  ) => boolean;
  validateEvidence: (
    actor: KnowledgeActor,
    evidence: KnowledgeEvidence[],
  ) => boolean;
  isArtifactAvailable?: (artifact: SharedKnowledge) => boolean;
  now?: () => string;
}
