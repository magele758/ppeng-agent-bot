import type { DatabaseSync } from 'node:sqlite';
import type { AgentMemory } from './types.js';

export interface MemorySuppression {
  id: string;
  memory: AgentMemory;
  reason: 'user_deleted';
  blockedCount: number;
  lastBlockedAt?: string;
  createdAt: string;
}

export class MemorySuppressedError extends Error {
  constructor() { super('memory_suppressed'); this.name = 'MemorySuppressedError'; }
}

export function ensureMemorySuppressionSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_suppressions (
    id TEXT PRIMARY KEY, memory_json TEXT NOT NULL, reason TEXT NOT NULL,
    blocked_count INTEGER NOT NULL DEFAULT 0, last_blocked_at TEXT, created_at TEXT NOT NULL
  )`);
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
    reason: 'user_deleted', blockedCount: Number(row.blocked_count),
    lastBlockedAt: row.last_blocked_at ? String(row.last_blocked_at) : undefined, createdAt: String(row.created_at)
  }));
}
