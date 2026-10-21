import type { SqliteStateStore } from '../storage.js';

export interface BotDelivery {
  taskId: string;
  sessionId: string;
  attempt: number;
  createdAt: string;
  executionStatus: string;
  report: string;
  failureReason: string | null;
  verification: 'unverified';
  manualReview?: { accepted: boolean; at: string };
  costUsd?: number | null;
  costSource?: 'provider_billing';
  approvalDecisions?: number;
  artifacts: Array<{ id: string; fileName: string; mimeType: string; totalBytes: number }>;
  receipts: Array<{ id: string; connectorId: string; toolName: string; state: string; result?: unknown; error?: string }>;
}

const baselineKey = (taskId: string, attempt: number) => `bot.delivery-baseline:${taskId}:${attempt}`;
const deliveryKey = (taskId: string, attempt: number) => `bot.delivery:${taskId}:${attempt}`;

export function beginBotDelivery(store: SqliteStateStore, taskId: string, sessionId: string, attempt: number): void {
  store.setDaemonControl(baselineKey(taskId, attempt), {
    artifactIds: store.listArtifactsForSession(sessionId).map(artifact => artifact.id),
    startedAt: new Date().toISOString(),
  });
}

/** Captured before the next human continuation starts; retries keep earlier attempts. */
export function finishBotDelivery(store: SqliteStateStore, input: {
  taskId: string; sessionId: string; attempt: number; executionStatus: string; report: string; failureReason: string | null;
}): void {
  if (readBotDelivery(store, input.taskId, input.attempt)) return;
  const baseline = store.getDaemonControl<{ artifactIds: string[]; startedAt: string }>(baselineKey(input.taskId, input.attempt));
  const receipts: BotDelivery['receipts'] = [];
  if (baseline && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='software_invocations'").get()) {
    const rows = store.db.prepare('SELECT payload FROM software_invocations WHERE task_id=? AND session_id=? AND started_at>=? ORDER BY seq')
      .all(input.taskId, input.sessionId, baseline.startedAt) as { payload: string }[];
    for (const row of rows) {
      const invocation = JSON.parse(row.payload) as BotDelivery['receipts'][number];
      receipts.push({ id: invocation.id, connectorId: invocation.connectorId, toolName: invocation.toolName,
        state: invocation.state, ...(invocation.result !== undefined ? { result: invocation.result } : {}),
        ...(invocation.error ? { error: invocation.error } : {}) });
    }
  }
  const previous = new Set(baseline?.artifactIds ?? []);
  // usageCostUsd is a token-price estimate, not a provider billing receipt.
  const costUsd=null;
  const approvalDecisions=baseline ? Number((store.db.prepare("SELECT count(*) AS n FROM approvals WHERE session_id=? AND created_at>=? AND status IN ('approved','rejected')")
    .get(input.sessionId,baseline.startedAt) as {n:number}).n) : undefined;
  const delivery: BotDelivery = {
    ...input, createdAt: new Date().toISOString(), verification: 'unverified', costUsd, approvalDecisions,
    artifacts: baseline ? store.listArtifactsForSession(input.sessionId).filter(artifact =>
      !previous.has(artifact.id) && artifact.sourceTool !== 'user_upload').map(artifact => ({
      id: artifact.id, fileName: artifact.fileName ?? artifact.id, mimeType: artifact.mimeType, totalBytes: artifact.totalBytes,
    })) : [],
    receipts,
  };
  store.setDaemonControl(deliveryKey(input.taskId, input.attempt), delivery);
}

export function readBotDelivery(store: SqliteStateStore, taskId: string, attempt: number): BotDelivery | undefined {
  return store.getDaemonControl<BotDelivery>(deliveryKey(taskId, attempt));
}
