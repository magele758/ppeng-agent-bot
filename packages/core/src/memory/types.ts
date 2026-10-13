export type MemoryScope =
  | 'session.scratch'
  | 'session.long'
  | 'user.memory'
  | 'team.memory'
  | 'project.memory';

export type MemoryConfidence = 'low' | 'medium' | 'high';

export interface AgentMemory {
  id: string;
  scope: MemoryScope;
  namespace: string;
  key: string;
  value: string;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  /** Bot namespace. Empty means shared user-level memory (legacy rows stay here). */
  agentId?: string;
  importance: number;
  source?: string;
  confidence: MemoryConfidence;
  expiresAt?: string;
  accessCount: number;
  lastAccessAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFilter {
  /** Restrict to the selected tenant plus legacy global rows; missing tenant means global only. */
  tenantOrGlobal?: boolean;
  scope?: MemoryScope;
  namespace?: string;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  /** Exact key match (session delete / lookup). */
  key?: string;
  /** When set, only this bot's rows. */
  agentId?: string;
  /** Only rows with no agentId (shared user-level memory). */
  agentUnscoped?: boolean;
  /** FTS full-text search query */
  query?: string;
  limit?: number;
  orderBy?: 'importance' | 'recency' | 'access_count';
}

export interface User {
  id: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  status: string;
  createdAt: string;
}

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

export interface Membership {
  userId: string;
  tenantId: string;
  role: string;
}

/** Independent user profile — never retrieved by similarity. */
export interface UserProfile {
  userId: string;
  displayName?: string;
  bio?: string;
  /** Free-form facts the operator or extractors wrote (not scored). */
  facts: string[];
  preferences: string[];
  updatedAt: string;
}

export type MemoryObservationKind = 'task_end' | 'user_correction' | 'dialogue_extract' | 'dream';
export type MemoryGateStatus = 'pending' | 'accepted' | 'merged' | 'dropped' | 'rejected' | 'skipped';

export interface MemoryObservation {
  id: string;
  kind: MemoryObservationKind;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  tenantId?: string;
  taskContent?: string;
  outcome?: 'success' | 'failure' | 'partial';
  toolsUsed: string[];
  rawSummary?: string;
  gate: MemoryGateStatus;
  gateReason?: string;
  writtenMemoryId?: string;
  createdAt: string;
}

export interface MemoryDreamRun {
  id: string;
  userId: string;
  tenantId?: string;
  dreamDate: string;
  status: 'running' | 'completed' | 'skipped' | 'throttled' | 'error';
  factsCount: number;
  summary?: string;
  journal?: string;
  startedAt: string;
  finishedAt?: string;
}

export type ContextSlotId = 'userProfile' | 'core' | 'working' | 'workingFile';

export interface CompiledContextSlot {
  id: ContextSlotId;
  title: string;
  text: string;
  chars: number;
  capped: boolean;
}

export interface CompiledContextPack {
  query: string;
  sections: CompiledContextSlot[];
  combined: string;
  combinedChars: number;
}
