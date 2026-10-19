import type { BotPrincipal } from "../bots/bot-identity.js";
import type { FactoryTask, FactorySettings } from "./types.js";
export interface DeliveryPolicy {
  enabled: boolean;
  allowedUserIds: string[];
  repository: string;
  repositoryNodeId: string;
  target: string;
  credentialRef: string;
  operations: ("push" | "pr" | "merge")[];
  requiredChecks: { workflowId: number; job: string; appId: number }[];
  workflowDigests?: Record<string, string>;
  ciVariablesDigest?: string;
  mergeIdentity?: {
    appId: number;
    installationId: number;
    credentialRef: string;
    rulesetId: number;
  };
  mergeMethod: "squash";
  maxRetries: number;
  deadlineMs: number;
  downstream: { confirmed: boolean; deploys: boolean };
  revision: string;
}
export type DeliveryStage =
  | "QUEUED"
  | "SYNC_WAIT"
  | "PUSHED"
  | "CI_WAIT"
  | "PR_READY"
  | "MERGED"
  | "WAITING_DECISION"
  | "VERIFYING"
  | "DEFERRED"
  | "PAUSED"
  | "CANCELLED";
export interface DeliveryGrant {
  userId: string;
  at: string;
  scope: "PR" | "MERGED";
  policyRevision: string;
  repositoryNodeId: string;
  target: string;
  revoked?: boolean;
}
export interface DeliveryRecord {
  taskId: string;
  controlVersion?: number;
  evidenceRecoveryRequired?: boolean;
  evidenceSnapshot?: { digest: string; bytes: number; available: boolean };
  stage: DeliveryStage;
  policy: DeliveryPolicy;
  grants: DeliveryGrant[];
  candidate: string;
  originalBase: string;
  deliveryBase: string;
  branch: string;
  identity: string;
  generation: number;
  developmentRevision: string;
  pushedSha?: string;
  pr?: any;
  mergeSha?: string;
  pending?: {
    id: string;
    action: "push" | "pr" | "merge";
    sha: string;
    at: string;
    finished?: boolean;
    outcome?: "completed" | "rejected";
  };
  attempts: number;
  createdAt: string;
  updatedAt: string;
  ciHistory: { at: string; candidate: string; base: string; checks: any[] }[];
  history: { kind: string; at: string; detail: unknown }[];
  decisions: {
    userId: string;
    at: string;
    action: string;
    sha?: string;
    rounds?: number;
  }[];
  sensitiveConfirmedSha?: string;
  reason?: string;
  deployment: "not_deployed";
}
export interface DeliveryHost {
  settings(p: BotPrincipal): FactorySettings;
  list(p: BotPrincipal): FactoryTask[];
  get(p: BotPrincipal, id: string): FactoryTask;
  updateDevelopment(t: FactoryTask): void;
  deliveryNotice?(t: FactoryTask, r: DeliveryRecord): void;
  development: {
    settings(p: BotPrincipal, m: string, r: string): any;
    current(p: BotPrincipal, id: string): any;
  };
}
export interface DeliveryRequest {
  action: string;
  taskId?: string;
  policy: DeliveryPolicy;
  sha?: string;
  branch?: string;
  [key: string]: unknown;
}
