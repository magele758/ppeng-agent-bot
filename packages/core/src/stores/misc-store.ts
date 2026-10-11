/**
 * Miscellaneous store: small domains grouped together.
 *
 * Covers agents, workspaces, scheduler-wake queue, and daemon-control KV.
 * Extracted from SqliteStateStore to reduce its surface area.
 * Takes a DatabaseSync instance via constructor injection.
 */
import type { DatabaseSync } from 'node:sqlite';
import { wakeFromSchedulerReason, withApprovalWake } from '../approval/unattended-approval.js';
import { createId, nowIso } from '../id.js';
import { serializeJson, parseJson } from './storage-helpers.js';
import type { AgentSpec, WorkspaceRecord } from '../types.js';

export class MiscStore {
  constructor(private readonly db: DatabaseSync) {}

  // ── Agent ──

  upsertAgent(agent: AgentSpec): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO agents (id, name, role, spec_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          role = excluded.role,
          spec_json = excluded.spec_json,
          updated_at = excluded.updated_at
      `)
      .run(agent.id, agent.name, agent.role, serializeJson(agent), now, now);
  }

  listAgents(): AgentSpec[] {
    const rows = this.db.prepare(`SELECT spec_json FROM agents ORDER BY id`).all() as Array<{ spec_json: string }>;
    return rows.map((row) => parseJson<AgentSpec>(row.spec_json));
  }

  getAgent(id: string): AgentSpec | undefined {
    const row = this.db.prepare(`SELECT spec_json FROM agents WHERE id = ?`).get(id) as
      | { spec_json: string }
      | undefined;
    return row ? parseJson<AgentSpec>(row.spec_json) : undefined;
  }

  // ── Workspace ──

  createWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
    this.db
      .prepare(`
        INSERT INTO workspaces (id, task_id, name, mode, source_path, root_path, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workspace.id,
        workspace.taskId,
        workspace.name,
        workspace.mode,
        workspace.sourcePath,
        workspace.rootPath,
        workspace.status,
        workspace.createdAt
      );

    return workspace;
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db.prepare(`SELECT * FROM workspaces ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapWorkspaceRow(row));
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkspaceRow(row) : undefined;
  }

  // ── Scheduler Wake ──

  enqueueSchedulerWake(sessionId: string, reason: string): void {
    this.db
      .prepare(`INSERT INTO scheduler_wake (id, session_id, reason, created_at) VALUES (?, ?, ?, ?)`)
      .run(createId('wake'), sessionId, reason, nowIso());
    this.stampUnattendedWake(sessionId, reason);
  }

  /** The queued wake is not a person sitting in Lab chat. */
  private stampUnattendedWake(sessionId: string, reason: string): void {
    const row = this.db
      .prepare(`SELECT metadata_json FROM sessions WHERE id = ?`)
      .get(sessionId) as { metadata_json?: string } | undefined;
    if (!row) return;
    const metadata = parseJson<Record<string, unknown>>(String(row.metadata_json ?? '')) ?? {};
    const next = withApprovalWake(metadata, wakeFromSchedulerReason(reason));
    this.db
      .prepare(`UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE id = ?`)
      .run(serializeJson(next), nowIso(), sessionId);
  }

  /** Returns distinct session ids in FIFO order (by first enqueue time per id in this batch). */
  dequeueSchedulerWakes(limit = 32): string[] {
    const rows = this.db
      .prepare(`SELECT id, session_id FROM scheduler_wake ORDER BY created_at ASC LIMIT ?`)
      .all(limit) as Array<{ id: string; session_id: string }>;
    if (rows.length === 0) {
      return [];
    }
    const del = this.db.prepare(`DELETE FROM scheduler_wake WHERE id = ?`);
    for (const row of rows) {
      del.run(row.id);
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of rows) {
      if (!seen.has(row.session_id)) {
        seen.add(row.session_id);
        ordered.push(row.session_id);
      }
    }
    return ordered;
  }

  // ── Daemon Control (generic KV) ──

  setDaemonControl(key: string, value: unknown): void {
    const now = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO daemon_control (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `
      )
      .run(key, serializeJson(value), now);
  }

  getDaemonControl<T>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT value_json FROM daemon_control WHERE key = ?`).get(key) as
      | { value_json: string }
      | undefined;
    return row ? (parseJson<T>(row.value_json) ?? undefined) : undefined;
  }

  deleteDaemonControl(key: string): void {
    this.db.prepare(`DELETE FROM daemon_control WHERE key = ?`).run(key);
  }

  private mapWorkspaceRow(row: Record<string, unknown>): WorkspaceRecord {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      name: String(row.name),
      mode: String(row.mode) as WorkspaceRecord['mode'],
      sourcePath: String(row.source_path),
      rootPath: String(row.root_path),
      status: String(row.status) as WorkspaceRecord['status'],
      createdAt: String(row.created_at)
    };
  }
}
