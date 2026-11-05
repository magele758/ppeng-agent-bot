import type { DatabaseSync } from 'node:sqlite';
import type { AgentMemory } from './types.js';

export type MemorySuppressionReason = 'user_deleted' | 'evicted' | 'expired';

/** Capacity eviction stays blocked briefly so the same fact is not written back immediately. */
export const EVICTED_SUPPRESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** Time-based expiry stays blocked for a day. User deletion never expires. */
export const EXPIRED_SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface MemorySuppression {
  id: string;
  memory: AgentMemory;
  reason: MemorySuppressionReason;
  blockedCount: number;
  lastBlockedAt?: string;
  createdAt: string;
  /** Absent for user_deleted. Past values are ignored and deleted on lookup. */
  expiresAt?: string;
}

export class MemorySuppressedError extends Error {
  readonly reason: MemorySuppressionReason;
  constructor(reason: MemorySuppressionReason = 'user_deleted') {
    super('memory_suppressed');
    this.name = 'MemorySuppressedError';
    this.reason = reason;
  }
}

function suppressionReason(raw: unknown): MemorySuppressionReason {
  const reason = String(raw);
  if (reason === 'evicted' || reason === 'expired' || reason === 'user_deleted') return reason;
  return 'user_deleted';
}

export function ensureMemorySuppressionSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_suppressions (
    id TEXT PRIMARY KEY, memory_json TEXT NOT NULL, reason TEXT NOT NULL,
    blocked_count INTEGER NOT NULL DEFAULT 0, last_blocked_at TEXT, created_at TEXT NOT NULL
  )`);
  const cols = db.prepare('PRAGMA table_info(memory_suppressions)').all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'expires_at')) {
    db.exec('ALTER TABLE memory_suppressions ADD COLUMN expires_at TEXT');
  }
}

// Deliberately conservative: equivalent preference phrasing, not broad fuzzy identity matches.
export function suppressionFactKey(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/偏好|喜爱|喜欢/g, '喜欢')
    .replace(/简短|简明|简洁/g, '简洁')
    .replace(/答复|回复|回答/g, '回答')
    .replace(/使用中文|用中文/g, '中文')
    .replace(/[\s\p{P}]/gu, '')
    .replace(/回答(?:要|应当|应该)?简洁/g, '简洁回答');
}

export function sameSuppressionScope(a: Pick<AgentMemory, 'scope'|'userId'|'tenantId'|'sessionId'|'agentId'>, b: Pick<AgentMemory, 'scope'|'userId'|'tenantId'|'sessionId'|'agentId'>): boolean {
  return a.scope === b.scope && (a.userId ?? '') === (b.userId ?? '') &&
    (a.tenantId ?? '') === (b.tenantId ?? '') && (a.agentId ?? '') === (b.agentId ?? '') &&
    (!a.scope.startsWith('session.') || (a.sessionId ?? '') === (b.sessionId ?? ''));
}

export function readSuppressions(db: DatabaseSync): MemorySuppression[] {
  return db.prepare('SELECT * FROM memory_suppressions ORDER BY created_at DESC, id').all().map(row => ({
    id: String(row.id), memory: JSON.parse(String(row.memory_json)) as AgentMemory,
    reason: suppressionReason(row.reason), blockedCount: Number(row.blocked_count),
    lastBlockedAt: row.last_blocked_at ? String(row.last_blocked_at) : undefined, createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : undefined
  }));
}
