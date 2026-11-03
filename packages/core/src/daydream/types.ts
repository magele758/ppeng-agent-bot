import type { DatabaseSync } from 'node:sqlite';
export interface DaydreamSettings {
  enabled: boolean;
  timezone: string;
  dailyAt: string;
  memoryPolicy: 'auto' | 'review';
  skillPolicy: 'propose' | 'autoPrivate';
  collaborationEnabled: boolean;
  maxChunks: number;
  effectiveFrom: string;
}
export interface DaydreamBot {
  id: string;
  tenantId?: string;
  userId?: string;
  /** False when this Bot has no conversation left to review. */
  runnable?: boolean;
}
export interface DaydreamArtifactRef {
  id: string;
  version: number;
  kind: 'memory' | 'skill';
  content?: string;
}
export interface DaydreamEvidence {
  outcome?: 'success' | 'failure';
  sourceSuppressed?: boolean;
  derivedFrom?: DaydreamArtifactRef[];
  sessionId: string;
  messageId: string;
  seq?: number;
  role: string;
  content: string;
  createdAt: string;
}
export interface DaydreamCandidate {
  conflict?: boolean;
  derivedFrom?: DaydreamArtifactRef[];
  kind: 'memory' | 'skill';
  content: string;
  name?: string;
  description?: string;
  category?: 'fact' | 'preference' | 'entity' | 'concept';
  evidenceIds: string[];
  evidenceRefs?: DaydreamEvidence[];
  shareable: boolean;
  reason: string;
}
export interface DaydreamOutput {
  candidate: DaydreamCandidate;
  status: 'pending' | 'saved' | 'rejected';
  artifactId?: string;
  error?: string;
}
export interface DaydreamRun {
  id: string;
  botId: string;
  tenantId?: string;
  date: string;
  timezone: string;
  status: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';
  checkpoint: number;
  inputs: DaydreamEvidence[];
  outputs: DaydreamOutput[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface DaydreamDeps {
  db: DatabaseSync;
  settingsStore: {
    getDaemonControl(key: string): unknown;
    setDaemonControl(key: string, value: unknown): void;
  };
  listBots(): DaydreamBot[];
  readEvidence(botId: string, date: string, timezone: string): Promise<DaydreamEvidence[]>;
  complete(botId: string, input: {
    system: string;
    user: string;
  }): Promise<string>;
  saveMemory(botId: string, candidate: DaydreamCandidate, idempotencyKey: string): Promise<string | null>;
  captureSkill(botId: string, candidate: DaydreamCandidate, idempotencyKey: string, autoInstall: boolean): Promise<string | null>;
  rejectSkill?(botId: string, artifactId: string): Promise<void>;
  submitKnowledge?(botId: string, candidate: DaydreamCandidate, artifactId: string, runId: string): Promise<unknown>;
  getSharedArtifacts?(botId: string): Promise<DaydreamArtifactRef[]>;
  getContext?(botId: string): Promise<string>;
  defaultTimezone?: string;
  now?: () => number;
}
