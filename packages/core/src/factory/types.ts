import type { BotPrincipal } from "../bots/bot-identity.js";
export type FactoryOperation = "snapshot" | "count-files" | "read-log";
export type FactoryStatus =
  | "queued"
  | "running"
  | "unknown"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";
export interface FactoryMachine {
  id: string;
  name: string;
  sshAlias: string;
  capacity: number;
  botIds: string[];
  allowedUserIds: string[];
  repositories: {
    id: string;
    path: string;
    logs?: { id: string; path: string }[];
  }[];
  identity?: string;
  online?: boolean;
  checkedAt?: string;
}
export interface FactorySettings {
  owner: BotPrincipal;
  machines: FactoryMachine[];
  roomId: string;
  coordinatorBotId: string;
  patrol: { enabled: boolean; timezone: "Asia/Shanghai" };
}
export interface FactoryTask {
  id: string;
  principal: BotPrincipal;
  machineId: string;
  machine: FactoryMachine;
  repositoryId: string;
  repositoryPath: string;
  operation: FactoryOperation;
  logId?: string;
  botId: string;
  roomId?: string;
  coordinatorBotId: string;
  requestKey: string;
  status: FactoryStatus;
  seq: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  identity?: string;
  result?: Record<string, unknown>;
  error?: string;
  history: { status: FactoryStatus; at: string }[];
  lastCheckedAt?: string;
}
export interface FactoryReport {
  status: FactoryStatus;
  seq: number;
  identity?: string;
  result?: Record<string, unknown>;
  error?: string;
  finished?: boolean;
}
export interface FactorySignals {
  process: boolean | null;
  fresh: boolean | null;
  commit: string | null;
  cpu: number | null;
}
export interface FactoryTransport {
  probe(
    machine: FactoryMachine,
  ): Promise<{ identity: string; hostname: string }>;
  start(machine: FactoryMachine, task: FactoryTask): Promise<FactoryReport>;
  status(machine: FactoryMachine, task: FactoryTask): Promise<FactoryReport>;
  inspect(machine: FactoryMachine, task: FactoryTask): Promise<FactorySignals>;
  close?(): Promise<void>;
}
export interface PatrolState {
  lastRunAt?: string;
  fingerprint?: string;
  checks: Record<string, { signals: FactorySignals; at: string; kind: string }>;
  notified: Record<string, boolean>;
}
