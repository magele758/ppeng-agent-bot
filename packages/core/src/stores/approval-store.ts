/**
 * Approval store: CRUD for tool-call approval records.
 *
 * Extracted from SqliteStateStore to isolate the approval domain.
 * Takes a DatabaseSync instance via constructor injection.
 */
import type { DatabaseSync } from 'node:sqlite';
import { authorizedByFromJson, normalizeAuthorizedBy } from '../approval/authorized-by.js';
import { NotFoundError } from '../errors.js';
import { createId, nowIso } from '../id.js';
import type { ApprovalRecord, ApprovalStatus } from '../types.js';
import { serializeJson, parseJson, optionalString } from './storage-helpers.js';

export class ApprovalStore {
  constructor(private readonly db: DatabaseSync) {}

  createApproval(
    input: Omit<ApprovalRecord, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { idempotencyKey?: string }
  ): ApprovalRecord {
    const reused = this.reusePendingApproval(input);
    if (reused) return reused;

    const authorizedBy = normalizeAuthorizedBy(input.authorizedBy);
    const approval: ApprovalRecord = {
      id: createId('approval'),
      sessionId: input.sessionId,
      toolName: input.toolName,
      status: 'pending',
      reason: input.reason,
      args: input.args,
      idempotencyKey: input.idempotencyKey,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.wakeSource ? { wakeSource: input.wakeSource } : {}),
      ...(authorizedBy ? { authorizedBy } : {})
    };

    this.db
      .prepare(`
        INSERT INTO approvals (
          id, session_id, tool_name, status, reason, args_json, idempotency_key,
          created_at, updated_at, expires_at, wake_source, authorized_by_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.sessionId,
        approval.toolName,
        approval.status,
        approval.reason,
        serializeJson(approval.args),
        approval.idempotencyKey ?? null,
        approval.createdAt,
        approval.updatedAt,
        approval.expiresAt ?? null,
        approval.wakeSource ?? null,
        approval.authorizedBy ? serializeJson(approval.authorizedBy) : null
      );

    return approval;
  }

  /** Same pending key returns the existing receipt and fills a missing citation. */
  private reusePendingApproval(
    input: Omit<ApprovalRecord, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { idempotencyKey?: string }
  ): ApprovalRecord | undefined {
    if (!input.idempotencyKey) return undefined;
    const dup = this.db
      .prepare(
        `SELECT * FROM approvals WHERE session_id = ? AND idempotency_key = ? AND status = 'pending' LIMIT 1`
      )
      .get(input.sessionId, input.idempotencyKey) as Record<string, unknown> | undefined;
    if (!dup) return undefined;
    const existing = this.mapApprovalRow(dup);
    const cited = normalizeAuthorizedBy(input.authorizedBy);
    if (!cited || existing.authorizedBy?.length) return existing;
    const updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE approvals SET authorized_by_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'`
      )
      .run(serializeJson(cited), updatedAt, existing.id);
    return { ...existing, authorizedBy: cited, updatedAt };
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRecord[] {
    const rows = (filter?.status
      ? this.db.prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC`).all(filter.status)
      : this.db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC`).all()) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapApprovalRow(row));
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapApprovalRow(row) : undefined;
  }

  updateApproval(id: string, status: ApprovalStatus): ApprovalRecord {
    const approval = this.getApproval(id);
    if (!approval) {
      throw new NotFoundError('Approval', id);
    }
    if (approval.status !== 'pending') return approval;

    const updatedAt = nowIso();
    const result = this.db
      .prepare(`UPDATE approvals SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, updatedAt, id);
    if (Number(result.changes) === 0) {
      return this.getApproval(id) ?? approval;
    }
    return { ...approval, status, updatedAt };
  }

  /**
   * Deny a still-pending unattended approval. A human decision that landed
   * first (status no longer pending, or no deadline) is left unchanged.
   */
  markApprovalExpired(id: string, expireReason: string): ApprovalRecord | undefined {
    const approval = this.getApproval(id);
    if (!approval) return undefined;
    if (approval.status !== 'pending' || !approval.expiresAt) return approval;
    const updatedAt = nowIso();
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = 'rejected', expire_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at IS NOT NULL`
      )
      .run(expireReason, updatedAt, id);
    if (Number(result.changes) === 0) {
      return this.getApproval(id) ?? approval;
    }
    return { ...approval, status: 'rejected', expireReason, updatedAt };
  }

  deleteApproval(id: string): void {
    this.db.prepare(`DELETE FROM approvals WHERE id = ?`).run(id);
  }

  private mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
    const expiresAt = optionalString(row.expires_at);
    const expireReason = optionalString(row.expire_reason);
    const wakeSource = optionalString(row.wake_source);
    const authorizedBy = authorizedByFromJson(row.authorized_by_json);
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      toolName: String(row.tool_name),
      status: String(row.status) as ApprovalStatus,
      reason: String(row.reason),
      args: parseJson<Record<string, unknown>>(String(row.args_json)),
      idempotencyKey: optionalString((row as { idempotency_key?: unknown }).idempotency_key),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(expiresAt ? { expiresAt } : {}),
      ...(expireReason ? { expireReason } : {}),
      ...(wakeSource ? { wakeSource } : {}),
      ...(authorizedBy ? { authorizedBy } : {})
    };
  }
}
