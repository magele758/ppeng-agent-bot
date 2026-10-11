/**
 * Lightweight API response types for daemon ↔ web-console communication.
 *
 * Explicit shapes (not Pick from runtime domain types) so this package stays
 * free of Node-only dependencies.
 */

import type { MessagePart, MessageRole } from './message-parts.js';

/** Canonical wire alias for MessagePart. */
export type ApiMessagePart = MessagePart;

/** Subset of SessionMessage for chat rendering. */
export type ApiChatMessage = {
  role: MessageRole;
  parts: MessagePart[];
};

/** Subset of SessionRecord for list views. */
export type ApiSessionSummary = {
  id: string;
  title: string;
  mode: 'chat' | 'task' | 'subagent' | 'teammate';
  status: 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'unknown';
  agentId: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

/** Subset of AgentSpec for agent lists. */
export type ApiAgentInfo = {
  id: string;
  role: string;
  name: string;
  domainId?: string;
};

/** Named persistent Bot + canonical session (Lab roster). */
export type ApiBotInfo = {
  id: string;
  name: string;
  title: string;
  description: string;
  agentId: string;
  canonicalSessionId: string;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Subset of TaskRecord for task list views. */
export type ApiTaskSummary = {
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  ownerAgentId?: string;
  sessionId?: string;
};

/** Social queue row for daemon + Ops panel. */
export type ApiSocialPostScheduleItem = {
  taskId: string;
  title: string;
  status: ApiTaskSummary['status'];
  sessionId?: string;
  publishAt: string;
  channels: string[];
  approval: string;
  dispatchState: string;
  idempotencyKey: string;
};

/** Subset of ApprovalRecord for approval lists / inline HITL. */
export type ApiApprovalItem = {
  id: string;
  toolName: string;
  sessionId: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  args: Record<string, unknown>;
  createdAt: string;
  /** Set when an unattended wake must be answered before this instant. */
  expiresAt?: string;
  /** Set when the approval was denied because nobody answered in time. */
  expireReason?: string;
  /** Unattended wake that raised this approval (`cron`, `routine`, …). */
  wakeSource?: string;
};

/** Subset of MailRecord for mail rendering. */
export type ApiMailItem = {
  fromAgentId: string;
  toAgentId: string;
  status: 'pending' | 'delivered' | 'read';
  createdAt: string;
  content: string;
};
