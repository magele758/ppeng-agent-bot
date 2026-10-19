/** Actual product-source faults, loaded only inside disposable process probes. */
export const MUTATIONS={
  ownership:{file:'packages/core/src/stores/session-store.ts',from:'if (existing.activeWriterRunId && this.isSessionWriterLive(sessionId)) {',to:'if (false && existing.activeWriterRunId && this.isSessionWriterLive(sessionId)) {',cases:['contend-model-chat']},
  stale:{file:'packages/core/src/stores/session-store.ts',from:"if (existing?.activeWriterRunId === runId) {\n      this.db.prepare('UPDATE sessions SET active_writer_run_id = NULL, updated_at = ? WHERE id = ? AND active_writer_run_id = ?')",to:"if (existing) {\n      this.db.prepare('UPDATE sessions SET active_writer_run_id = NULL, updated_at = ? WHERE id = ? AND ? IS NOT NULL')",cases:['release-control-chat']},
  approval:{file:'packages/core/src/runtime/session-facade.ts',from:'[textPart(`Approval for ${approval.toolName} was ${decision}. Continue.`)]',to:'[textPart(`Approval for ${approval.toolName} was ${decision}. Continue.`)]); store.appendMessage(session.id, \'user\', [textPart(`Approval for ${approval.toolName} was ${decision}. Continue.`)]',cases:['approval-final-control-chat']},
};
export const CUTS=[
  {file:'packages/core/src/stores/session-store.ts',from:'  claimWriter(sessionId: string, runId: string): void {',to:'  claimWriter(sessionId: string, runId: string): void {\n    (globalThis as any).__concurrencyCut?.("before-claim");'},
  {file:'packages/core/src/stores/session-store.ts',from:'  releaseWriter(sessionId: string, runId: string): void {\n    const existing = this.getSession(sessionId);',to:'  releaseWriter(sessionId: string, runId: string): void {\n    (globalThis as any).__concurrencyCut?.("before-release");\n    const existing = this.getSession(sessionId);\n    (globalThis as any).__concurrencyCut?.("after-release-read");'},
  {file:'packages/core/src/runtime/session-facade.ts',from:"  if (existing.status !== 'pending') return existing;",to:"  if (existing.status !== 'pending') return existing;\n  (globalThis as any).__concurrencyCut?.('before-decision-write');"},
];
