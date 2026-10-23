import { MemorySuppressedError, readSuppressions, sameSuppressionScope, suppressionFactKey, type MemorySuppression } from './deletion-suppression.js';
import type { DatabaseSync } from 'node:sqlite';
import { createId, nowIso } from '../id.js';
import type {
  AgentMemory,
  MemoryConfidence,
  MemoryDreamRun,
  MemoryFilter,
  MemoryGateStatus,
  MemoryObservation,
  MemoryObservationKind,
  MemoryScope,
  Membership,
  Tenant,
  User,
  UserProfile
} from './types.js';

// Capacity limits per scope (configurable via constructor)
const DEFAULT_LIMITS: Record<MemoryScope, number> = {
  'session.scratch': 200,
  'session.long': 500,
  'user.memory': 5000,
  'team.memory': 2000,
  'project.memory': 5000,
  library: 20000
};

// ── Row mappers ──

function parseEmbeddingJson(raw: string | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'number')) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mapMemoryRow(row: Record<string, unknown>): AgentMemory {
  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    namespace: String(row.namespace),
    key: String(row.key),
    value: String(row.value),
    userId: row.user_id != null ? String(row.user_id) : undefined,
    tenantId: row.tenant_id != null ? String(row.tenant_id) : undefined,
    sessionId: row.session_id != null ? String(row.session_id) : undefined,
    agentId: row.agent_id != null && String(row.agent_id).trim() ? String(row.agent_id) : undefined,
    importance: Number(row.importance ?? 0.5),
    source: row.source != null ? String(row.source) : undefined,
    confidence: String(row.confidence ?? 'medium') as MemoryConfidence,
    expiresAt: row.expires_at != null ? String(row.expires_at) : undefined,
    accessCount: Number(row.access_count ?? 0),
    lastAccessAt: row.last_access_at != null ? String(row.last_access_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapUserRow(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: row.email != null ? String(row.email) : undefined,
    displayName: row.display_name != null ? String(row.display_name) : undefined,
    avatarUrl: row.avatar_url != null ? String(row.avatar_url) : undefined,
    status: String(row.status ?? 'active'),
    createdAt: String(row.created_at)
  };
}

function mapTenantRow(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at)
  };
}

function mapMembershipRow(row: Record<string, unknown>): Membership {
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    role: String(row.role ?? 'member')
  };
}

// Build the identity WHERE fragment for scope+namespace+key+owner
function ownerClause(opts: {
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  agentId?: string;
  /** Session scopes are already isolated by session_id; agent_id is a stamp, not identity. */
  ignoreAgent?: boolean;
}): { sql: string; values: (string | null)[] } {
  const parts: string[] = [];
  const values: (string | null)[] = [];

  if (opts.userId !== undefined) {
    parts.push('user_id = ?');
    values.push(opts.userId);
  } else {
    parts.push('user_id IS NULL');
  }
  if (opts.tenantId !== undefined) {
    parts.push('tenant_id = ?');
    values.push(opts.tenantId);
  } else {
    parts.push('tenant_id IS NULL');
  }
  if (opts.sessionId !== undefined) {
    parts.push('session_id = ?');
    values.push(opts.sessionId);
  } else {
    parts.push('session_id IS NULL');
  }
  if (!opts.ignoreAgent) {
    const agentId = opts.agentId?.trim();
    if (agentId) {
      parts.push('agent_id = ?');
      values.push(agentId);
    } else {
      parts.push('agent_id IS NULL');
    }
  }

  return { sql: parts.join(' AND '), values };
}

function isSessionScope(scope: MemoryScope): boolean {
  return scope === 'session.scratch' || scope === 'session.long';
}

function pushAgentFilter(
  filter: Pick<MemoryFilter, 'agentId' | 'agentUnscoped'>,
  conditions: string[],
  values: Array<string | number | null>,
  column = 'agent_id'
): void {
  const agentId = filter.agentId?.trim();
  if (agentId) {
    conditions.push(`${column} = ?`);
    values.push(agentId);
    return;
  }
  if (filter.agentUnscoped) conditions.push(`${column} IS NULL`);
}

export class AgentMemoryStore {
  private readonly limits: Record<MemoryScope, number>;
  /**
   * Whether the FTS virtual table exists. Probed on first search, not in the constructor:
   * SqliteStateStore builds this store before its migrations create `agent_memory_fts`.
   */
  private ftsAvailable: boolean | null = null;
  private embeddingTableReady: boolean | null = null;
  private sourceTableReady = false;

  constructor(
    private readonly db: DatabaseSync,
    limits?: Partial<Record<MemoryScope, number>>
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.ensureEmbeddingTable();
  }

  private hasFts(): boolean {
    if (this.ftsAvailable === null) {
      try {
        this.db.prepare(`SELECT 1 FROM agent_memory_fts LIMIT 1`).all();
        this.ftsAvailable = true;
      } catch {
        this.ftsAvailable = false;
      }
    }
    return this.ftsAvailable;
  }

  private ensureSources(): void {
    if (this.sourceTableReady) return;
    this.db.prepare('SELECT memory_id FROM agent_memory_sources LIMIT 0').all();
    this.sourceTableReady = true;
  }

  private withSources(row: Record<string, unknown>): AgentMemory {
    const memory = mapMemoryRow(row);
    this.ensureSources();
    const source = this.db.prepare('SELECT refs_json FROM agent_memory_sources WHERE memory_id = ?').get(memory.id) as { refs_json: string } | undefined;
    if (source) {
      memory.sourceRefs = JSON.parse(source.refs_json);
      memory.sourceMessageIds = memory.sourceRefs!.map(ref => ref.messageId);
      const seqs = memory.sourceRefs!.flatMap(ref => ref.seq === undefined ? [] : [ref.seq]);
      if (seqs.length) { memory.sourceSeqStart = Math.min(...seqs); memory.sourceSeqEnd = Math.max(...seqs); }
    }
    return memory;
  }

  private saveSources(id: string, refs: AgentMemory['sourceRefs']): void {
    if (refs === undefined) return;
    this.ensureSources();
    const valid = refs.filter(ref => ref && typeof ref.sessionId === 'string' && typeof ref.messageId === 'string');
    const normalized = valid.length > 200 ? [valid[0]!, ...valid.slice(-199)] : valid;
    this.db.prepare('INSERT INTO agent_memory_sources(memory_id,refs_json) VALUES (?,?) ON CONFLICT(memory_id) DO UPDATE SET refs_json=excluded.refs_json').run(id, JSON.stringify(normalized));
  }

  // ── Memory CRUD ──

  private ensureRevisions(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_memory_revisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_memory_revision_id ON agent_memory_revisions(memory_id,seq);`);
  }

  /** Audit-only: old values are never included in normal recall/search results. */
  revisions(id: string): Array<Pick<AgentMemory, 'value'|'source'|'updatedAt'|'sourceRefs'>> {
    this.ensureRevisions();
    const rows = this.db.prepare('SELECT payload FROM agent_memory_revisions WHERE memory_id=? ORDER BY seq DESC LIMIT 50')
      .all(id) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }

  set(memory: Omit<AgentMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'> & Partial<Pick<AgentMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>>): AgentMemory {
    this.db.exec('SAVEPOINT memory_write');
    try {
      const blocked = this.findSuppression(memory);
      if (blocked) {
        this.db.prepare('UPDATE memory_suppressions SET blocked_count=blocked_count+1,last_blocked_at=? WHERE id=?').run(nowIso(), blocked.id);
        this.db.exec('RELEASE memory_write');
        throw new MemorySuppressedError();
      }
      const entry = this.setAllowed(memory);
      this.db.exec('RELEASE memory_write');
      return entry;
    } catch (error) {
      if (!(error instanceof MemorySuppressedError)) this.db.exec('ROLLBACK TO memory_write; RELEASE memory_write');
      throw error;
    }
  }

  private setAllowed(memory: Parameters<AgentMemoryStore['set']>[0]): AgentMemory {
    const now = nowIso();
    const agentId = memory.agentId?.trim() || undefined;
    const owner = ownerClause({
      userId: memory.userId,
      tenantId: memory.tenantId,
      sessionId: memory.sessionId,
      agentId,
      ignoreAgent: isSessionScope(memory.scope)
    });

    const existing = this.db
      .prepare(
        `SELECT id FROM agent_memory WHERE scope = ? AND namespace = ? AND key = ? AND ${owner.sql}`
      )
      .get(memory.scope, memory.namespace, memory.key, ...owner.values) as
      | { id: string }
      | undefined;

    if (existing) {
      const previous = this.getEntryById(existing.id)!;
      if (previous.value !== memory.value) {
        this.ensureRevisions();
        this.db.prepare('INSERT INTO agent_memory_revisions(memory_id,payload) VALUES(?,?)').run(existing.id,
          JSON.stringify({ value: previous.value, source: previous.source, updatedAt: previous.updatedAt, sourceRefs: previous.sourceRefs }));
        this.db.prepare('DELETE FROM agent_memory_revisions WHERE memory_id=? AND seq NOT IN (SELECT seq FROM agent_memory_revisions WHERE memory_id=? ORDER BY seq DESC LIMIT 50)').run(existing.id,existing.id);
      }
      this.db
        .prepare(
          `UPDATE agent_memory SET value = ?, importance = ?, source = ?, confidence = ?,
           expires_at = ?, updated_at = ?, agent_id = COALESCE(?, agent_id) WHERE id = ?`
        )
        .run(
          memory.value,
          memory.importance ?? 0.5,
          memory.source ?? null,
          memory.confidence ?? 'medium',
          memory.expiresAt ?? null,
          now,
          agentId ?? null,
          existing.id
        );
      this.deleteEmbedding(existing.id);
      this.saveSources(existing.id, memory.sourceRefs);
      return this.getEntryById(existing.id)!;
    }

    const id = memory.id ?? createId('amem');
    this.db
      .prepare(
        `INSERT INTO agent_memory
           (id, scope, namespace, key, value, user_id, tenant_id, session_id, agent_id,
            importance, source, confidence, expires_at, access_count,
            last_access_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        id,
        memory.scope,
        memory.namespace,
        memory.key,
        memory.value,
        memory.userId ?? null,
        memory.tenantId ?? null,
        memory.sessionId ?? null,
        agentId ?? null,
        memory.importance ?? 0.5,
        memory.source ?? null,
        memory.confidence ?? 'medium',
        memory.expiresAt ?? null,
        now,
        memory.createdAt ?? now,
        now
      );

    this.saveSources(id, memory.sourceRefs);
    this.enforceLimit(memory.scope, memory.userId, memory.tenantId, memory.sessionId, agentId);
    return this.getEntryById(id)!;
  }

  get(opts: {
    scope: MemoryScope;
    namespace: string;
    key: string;
    userId?: string;
    tenantId?: string;
    sessionId?: string;
    agentId?: string;
  }): AgentMemory | null {
    const owner = ownerClause({
      userId: opts.userId,
      tenantId: opts.tenantId,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      ignoreAgent: isSessionScope(opts.scope)
    });
    const row = this.db
      .prepare(
        `SELECT * FROM agent_memory WHERE scope = ? AND namespace = ? AND key = ? AND ${owner.sql}`
      )
      .get(opts.scope, opts.namespace, opts.key, ...owner.values) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    // Increment access count
    const now = nowIso();
    this.db
      .prepare(`UPDATE agent_memory SET access_count = access_count + 1, last_access_at = ? WHERE id = ?`)
      .run(now, String(row.id));

    return this.withSources({ ...row, access_count: Number(row.access_count ?? 0) + 1, last_access_at: now });
  }

  getEntryById(id: string): AgentMemory | null {
    const row = this.db.prepare(`SELECT * FROM agent_memory WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.withSources(row) : null;
  }

  listSuppressions(): MemorySuppression[] { return readSuppressions(this.db); }

  findSuppression(memory: Pick<AgentMemory, 'scope'|'userId'|'tenantId'|'sessionId'|'agentId'|'value'>): MemorySuppression | undefined {
    const key = suppressionFactKey(memory.value);
    return this.listSuppressions().find(row => sameSuppressionScope(row.memory, memory) && suppressionFactKey(row.memory.value) === key);
  }

  assertNotSuppressed(memory: Parameters<AgentMemoryStore['findSuppression']>[0]): void {
    const blocked = this.findSuppression(memory);
    if (!blocked) return;
    this.db.prepare('UPDATE memory_suppressions SET blocked_count=blocked_count+1,last_blocked_at=? WHERE id=?').run(nowIso(), blocked.id);
    throw new MemorySuppressedError();
  }

  deleteAndSuppress(id: string): MemorySuppression | undefined {
    this.db.exec('SAVEPOINT memory_delete');
    try {
      const memory = this.getEntryById(id);
      if (!memory) { this.db.exec('RELEASE memory_delete'); return undefined; }
      const sid = createId('msup');
      this.db.prepare('INSERT INTO memory_suppressions(id,memory_json,reason,created_at) VALUES(?,?,?,?)').run(sid, JSON.stringify(memory), 'user_deleted', nowIso());
      this.delete(id);
      this.db.exec('RELEASE memory_delete');
      return this.listSuppressions().find(row => row.id === sid);
    } catch (error) { this.db.exec('ROLLBACK TO memory_delete; RELEASE memory_delete'); throw error; }
  }

  restoreSuppression(id: string): AgentMemory | undefined {
    this.db.exec('SAVEPOINT memory_restore');
    try {
      const row = this.listSuppressions().find(item => item.id === id);
      if (!row) { this.db.exec('RELEASE memory_restore'); return undefined; }
      this.db.prepare('DELETE FROM memory_suppressions WHERE id=?').run(id);
      const entry = this.set({ ...row.memory, expiresAt: undefined });
      this.db.exec('RELEASE memory_restore');
      return entry;
    } catch (error) { this.db.exec('ROLLBACK TO memory_restore; RELEASE memory_restore'); throw error; }
  }

  delete(id: string): void {
    this.ensureSources();
    this.ensureRevisions();
    this.db.prepare('DELETE FROM agent_memory_revisions WHERE memory_id=?').run(id);
    this.db.prepare('DELETE FROM agent_memory_sources WHERE memory_id = ?').run(id);
    this.deleteEmbedding(id);
    this.db.prepare(`DELETE FROM agent_memory WHERE id = ?`).run(id);
  }

  /**
   * SQLite sidecar for optional vectors. Not pgvector — JSON blob, fail-open.
   */
  private ensureEmbeddingTable(): boolean {
    if (this.embeddingTableReady != null) return this.embeddingTableReady;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_embedding (
          memory_id TEXT PRIMARY KEY,
          model TEXT,
          embedding_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.embeddingTableReady = true;
    } catch {
      this.embeddingTableReady = false;
    }
    return this.embeddingTableReady;
  }

  putEmbedding(memoryId: string, embedding: number[], model?: string): void {
    if (!this.ensureEmbeddingTable()) return;
    if (!Array.isArray(embedding) || embedding.length === 0) return;
    try {
      this.db
        .prepare(
          `INSERT INTO agent_memory_embedding (memory_id, model, embedding_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             model = excluded.model,
             embedding_json = excluded.embedding_json,
             updated_at = excluded.updated_at`
        )
        .run(memoryId, model ?? null, JSON.stringify(embedding), nowIso());
    } catch {
      /* fail-open */
    }
  }

  getEmbedding(memoryId: string): number[] | null {
    if (!this.ensureEmbeddingTable()) return null;
    try {
      const row = this.db
        .prepare(`SELECT embedding_json FROM agent_memory_embedding WHERE memory_id = ?`)
        .get(memoryId) as { embedding_json: string } | undefined;
      return parseEmbeddingJson(row?.embedding_json);
    } catch {
      return null;
    }
  }

  listEmbeddings(ids?: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    if (!this.ensureEmbeddingTable()) return out;
    try {
      if (ids) {
        const stmt = this.db.prepare(
          `SELECT memory_id, embedding_json FROM agent_memory_embedding WHERE memory_id = ?`
        );
        for (const id of ids) {
          const row = stmt.get(id) as { memory_id: string; embedding_json: string } | undefined;
          const emb = parseEmbeddingJson(row?.embedding_json);
          if (emb) out.set(id, emb);
        }
        return out;
      }
      const rows = this.db
        .prepare(`SELECT memory_id, embedding_json FROM agent_memory_embedding LIMIT 200`)
        .all() as Array<{ memory_id: string; embedding_json: string }>;
      for (const row of rows) {
        const emb = parseEmbeddingJson(row.embedding_json);
        if (emb) out.set(String(row.memory_id), emb);
      }
    } catch {
      /* fail-open */
    }
    return out;
  }

  deleteEmbedding(memoryId: string): void {
    if (!this.ensureEmbeddingTable()) return;
    try {
      this.db.prepare(`DELETE FROM agent_memory_embedding WHERE memory_id = ?`).run(memoryId);
    } catch {
      /* fail-open */
    }
  }

  /** Increment access_count for an entry by id (session-memory bridge touch). */
  touchById(id: string): AgentMemory | null {
    const row = this.getEntryById(id);
    if (!row) return null;
    const now = nowIso();
    const newCount = row.accessCount + 1;
    this.db
      .prepare(
        `UPDATE agent_memory SET access_count = ?, last_access_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(newCount, now, now, id);
    return this.getEntryById(id);
  }

  search(filter: MemoryFilter): AgentMemory[] {
    const limit = filter.limit ?? 20;

    if (filter.query && this.hasFts()) {
      try {
        const fts = this.ftsSearch(filter);
        if (fts.length > 0) return fts;
      } catch {
        /* MATCH syntax / empty index → LIKE fallback */
      }
    }

    const conditions: string[] = [];
    const values: (string | number | null)[] = [];

    if (filter.scope) {
      conditions.push('scope = ?');
      values.push(filter.scope);
    }
    if (filter.namespace) {
      conditions.push('namespace = ?');
      values.push(filter.namespace);
    }
    if (filter.userId !== undefined) {
      if (filter.userId === null) {
        conditions.push('user_id IS NULL');
      } else {
        conditions.push('user_id = ?');
        values.push(filter.userId);
      }
    }
    if (filter.tenantOrGlobal) {
      conditions.push('(tenant_id IS NULL OR tenant_id = ?)');
      values.push(filter.tenantId ?? null);
    } else if (filter.tenantId !== undefined) {
      conditions.push('tenant_id = ?');
      values.push(filter.tenantId);
    }
    if (filter.sessionId !== undefined) {
      conditions.push('session_id = ?');
      values.push(filter.sessionId);
    }
    if (filter.key) {
      conditions.push('key = ?');
      values.push(filter.key);
    }
    pushAgentFilter(filter, conditions, values);
    if (filter.query) {
      // Fallback LIKE when FTS unavailable
      conditions.push('(key LIKE ? OR value LIKE ?)');
      values.push(`%${filter.query}%`, `%${filter.query}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy =
      filter.orderBy === 'importance'
        ? 'importance DESC'
        : filter.orderBy === 'access_count'
        ? 'access_count DESC'
        : 'updated_at DESC';

    const rows = this.db
      .prepare(`SELECT * FROM agent_memory ${where} ORDER BY ${orderBy} LIMIT ?`)
      .all(...values, limit) as Array<Record<string, unknown>>;

    return rows.map(row => this.withSources(row));
  }

  private ftsSearch(filter: MemoryFilter): AgentMemory[] {
    const limit = filter.limit ?? 20;
    const conditions: string[] = ['agent_memory_fts MATCH ?'];
    const values: Array<string | number | null> = [filter.query!];
    if (filter.scope) {
      conditions.push('am.scope = ?');
      values.push(filter.scope);
    }
    if (filter.namespace) {
      conditions.push('am.namespace = ?');
      values.push(filter.namespace);
    }
    if (filter.userId !== undefined) {
      if (filter.userId === null) {
        conditions.push('am.user_id IS NULL');
      } else {
        conditions.push('am.user_id = ?');
        values.push(filter.userId);
      }
    }
    if (filter.tenantOrGlobal) {
      conditions.push('(am.tenant_id IS NULL OR am.tenant_id = ?)');
      values.push(filter.tenantId ?? null);
    } else if (filter.tenantId !== undefined) {
      conditions.push('am.tenant_id = ?');
      values.push(filter.tenantId);
    }
    if (filter.sessionId !== undefined) {
      conditions.push('am.session_id = ?');
      values.push(filter.sessionId);
    }
    if (filter.key) {
      conditions.push('am.key = ?');
      values.push(filter.key);
    }
    pushAgentFilter(filter, conditions, values, 'am.agent_id');
    const rows = this.db
      .prepare(
        `SELECT am.* FROM agent_memory am
         JOIN agent_memory_fts fts ON am.rowid = fts.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY rank
         LIMIT ?`
      )
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.withSources(row));
  }

  /** Delete expired entries; returns count deleted. */
  expire(): number {
    const now = nowIso();
    const result = this.db
      .prepare(`DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(now);
    return Number(result.changes);
  }

  /**
   * Enforce capacity limit for a scope+owner combination.
   * When over limit, removes lowest-importance + oldest entries.
   */
  enforceLimit(
    scope: MemoryScope,
    userId?: string,
    tenantId?: string,
    sessionId?: string,
    agentId?: string
  ): void {
    const maxCount = this.limits[scope];
    const owner = ownerClause({ userId, tenantId, sessionId, agentId, ignoreAgent: isSessionScope(scope) });

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM agent_memory WHERE scope = ? AND ${owner.sql}`)
      .get(scope, ...owner.values) as { cnt: number };

    const over = countRow.cnt - maxCount;
    if (over <= 0) return;

    const evictArgs: (string | number | null)[] = [scope, ...owner.values, over];
    const evictRows = this.db
      .prepare(
        `SELECT id FROM agent_memory WHERE scope = ? AND ${owner.sql}
         ORDER BY importance ASC, updated_at ASC LIMIT ?`
      )
      .all(...evictArgs) as Array<{ id: string }>;

    const stmt = this.db.prepare(`DELETE FROM agent_memory WHERE id = ?`);
    for (const row of evictRows) {
      stmt.run(row.id);
    }
  }

  // ── User management ──

  upsertUser(user: User): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO users (id, email, display_name, avatar_url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           status = excluded.status`
      )
      .run(
        user.id,
        user.email ?? null,
        user.displayName ?? null,
        user.avatarUrl ?? null,
        user.status,
        user.createdAt ?? now
      );
  }

  getUser(id: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapUserRow(row) : null;
  }

  getUserByEmail(email: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as
      | Record<string, unknown>
      | undefined;
    return row ? mapUserRow(row) : null;
  }

  listUsers(): User[] {
    const rows = this.db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapUserRow);
  }

  // ── Tenant management ──

  upsertTenant(tenant: Tenant): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
      )
      .run(tenant.id, tenant.name, tenant.createdAt ?? now);
  }

  getTenant(id: string): Tenant | null {
    const row = this.db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapTenantRow(row) : null;
  }

  listTenants(): Tenant[] {
    const rows = this.db.prepare(`SELECT * FROM tenants ORDER BY created_at DESC`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapTenantRow);
  }

  // ── Membership management ──

  addMembership(m: Membership): void {
    this.db
      .prepare(
        `INSERT INTO memberships (user_id, tenant_id, role)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`
      )
      .run(m.userId, m.tenantId, m.role);
  }

  getMemberships(userId: string): Membership[] {
    const rows = this.db
      .prepare(`SELECT * FROM memberships WHERE user_id = ?`)
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(mapMembershipRow);
  }

  countMemberships(tenantId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ?`)
      .get(tenantId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  // ── User profile (independent; never similarity-recalled) ──

  getUserProfile(userId: string): UserProfile | null {
    try {
      const row = this.db.prepare(`SELECT * FROM user_profiles WHERE user_id = ?`).get(userId) as
        | Record<string, unknown>
        | undefined;
      return row ? mapProfileRow(row) : null;
    } catch {
      return null;
    }
  }

  upsertUserProfile(profile: Omit<UserProfile, 'updatedAt'> & { updatedAt?: string }): UserProfile {
    const now = nowIso();
    this.ensureUser(profile.userId);
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, display_name, bio, facts_json, preferences_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = excluded.display_name,
           bio = excluded.bio,
           facts_json = excluded.facts_json,
           preferences_json = excluded.preferences_json,
           updated_at = excluded.updated_at`
      )
      .run(
        profile.userId,
        profile.displayName ?? null,
        profile.bio ?? null,
        JSON.stringify(profile.facts ?? []),
        JSON.stringify(profile.preferences ?? []),
        profile.updatedAt ?? now
      );
    return this.getUserProfile(profile.userId)!;
  }

  // ── Observations (curator / extract) ──

  insertObservation(input: {
    kind: MemoryObservationKind;
    sessionId?: string;
    userId?: string;
    agentId?: string;
    tenantId?: string;
    taskContent?: string;
    outcome?: 'success' | 'failure' | 'partial';
    toolsUsed?: string[];
    rawSummary?: string;
    gate?: MemoryGateStatus;
    gateReason?: string;
    writtenMemoryId?: string;
  }): MemoryObservation {
    const id = createId('mobs');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_observations
           (id, kind, session_id, user_id, agent_id, tenant_id, task_content, outcome,
            tools_used_json, raw_summary, gate, gate_reason, written_memory_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.sessionId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.tenantId ?? null,
        input.taskContent ?? null,
        input.outcome ?? null,
        JSON.stringify(input.toolsUsed ?? []),
        input.rawSummary ?? null,
        input.gate ?? 'pending',
        input.gateReason ?? null,
        input.writtenMemoryId ?? null,
        now
      );
    return this.getObservation(id)!;
  }

  getObservation(id: string): MemoryObservation | null {
    const row = this.db.prepare(`SELECT * FROM memory_observations WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapObservationRow(row) : null;
  }

  updateObservation(
    id: string,
    patch: { gate?: MemoryGateStatus; gateReason?: string; writtenMemoryId?: string }
  ): MemoryObservation | null {
    const cur = this.getObservation(id);
    if (!cur) return null;
    this.db
      .prepare(
        `UPDATE memory_observations SET gate = ?, gate_reason = ?, written_memory_id = ? WHERE id = ?`
      )
      .run(
        patch.gate ?? cur.gate,
        patch.gateReason ?? cur.gateReason ?? null,
        patch.writtenMemoryId ?? cur.writtenMemoryId ?? null,
        id
      );
    return this.getObservation(id);
  }

  listObservations(filter?: { sessionId?: string; userId?: string; limit?: number }): MemoryObservation[] {
    const limit = filter?.limit ?? 40;
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (filter?.sessionId) {
      conditions.push('session_id = ?');
      values.push(filter.sessionId);
    }
    if (filter?.userId) {
      conditions.push('user_id = ?');
      values.push(filter.userId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM memory_observations ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map(mapObservationRow);
  }

  // ── Dreamer runs ──

  claimDreamRun(input: {
    userId: string;
    tenantId?: string;
    dreamDate: string;
    force?: boolean;
  }): MemoryDreamRun | null {
    const now = nowIso();
    if (input.force) {
      const existing = this.db
        .prepare(`SELECT id FROM memory_dream_runs WHERE user_id = ? AND dream_date = ?`)
        .get(input.userId, input.dreamDate) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE memory_dream_runs SET status = 'running', started_at = ?, finished_at = NULL,
             facts_count = 0, summary = NULL, journal = NULL WHERE id = ?`
          )
          .run(now, existing.id);
        return this.getDreamRun(existing.id);
      }
    } else {
      const existing = this.db
        .prepare(`SELECT id, status FROM memory_dream_runs WHERE user_id = ? AND dream_date = ?`)
        .get(input.userId, input.dreamDate) as { id: string; status: string } | undefined;
      if (existing && existing.status !== 'error') return null;
    }
    const id = createId('mdream');
    this.db
      .prepare(
        `INSERT INTO memory_dream_runs
           (id, user_id, tenant_id, dream_date, status, facts_count, started_at)
         VALUES (?, ?, ?, ?, 'running', 0, ?)`
      )
      .run(id, input.userId, input.tenantId ?? null, input.dreamDate, now);
    return this.getDreamRun(id);
  }

  getDreamRun(id: string): MemoryDreamRun | null {
    const row = this.db.prepare(`SELECT * FROM memory_dream_runs WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDreamRow(row) : null;
  }

  finishDreamRun(
    id: string,
    patch: { status: MemoryDreamRun['status']; factsCount: number; summary?: string; journal?: string }
  ): void {
    this.db
      .prepare(
        `UPDATE memory_dream_runs SET status = ?, facts_count = ?, summary = ?, journal = ?, finished_at = ? WHERE id = ?`
      )
      .run(patch.status, patch.factsCount, patch.summary ?? null, patch.journal ?? null, nowIso(), id);
  }

  latestDreamRun(userId: string): MemoryDreamRun | null {
    const row = this.db
      .prepare(`SELECT * FROM memory_dream_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(userId) as Record<string, unknown> | undefined;
    return row ? mapDreamRow(row) : null;
  }

  private ensureUser(userId: string): void {
    const existing = this.getUser(userId);
    if (existing) return;
    this.upsertUser({ id: userId, status: 'active', createdAt: nowIso() });
  }
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function mapProfileRow(row: Record<string, unknown>): UserProfile {
  return {
    userId: String(row.user_id),
    displayName: row.display_name != null ? String(row.display_name) : undefined,
    bio: row.bio != null ? String(row.bio) : undefined,
    facts: parseJsonArray(row.facts_json),
    preferences: parseJsonArray(row.preferences_json),
    updatedAt: String(row.updated_at)
  };
}

function mapObservationRow(row: Record<string, unknown>): MemoryObservation {
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryObservationKind,
    sessionId: row.session_id != null ? String(row.session_id) : undefined,
    userId: row.user_id != null ? String(row.user_id) : undefined,
    agentId: row.agent_id != null ? String(row.agent_id) : undefined,
    tenantId: row.tenant_id != null ? String(row.tenant_id) : undefined,
    taskContent: row.task_content != null ? String(row.task_content) : undefined,
    outcome: row.outcome != null ? (String(row.outcome) as MemoryObservation['outcome']) : undefined,
    toolsUsed: parseJsonArray(row.tools_used_json),
    rawSummary: row.raw_summary != null ? String(row.raw_summary) : undefined,
    gate: String(row.gate ?? 'pending') as MemoryGateStatus,
    gateReason: row.gate_reason != null ? String(row.gate_reason) : undefined,
    writtenMemoryId: row.written_memory_id != null ? String(row.written_memory_id) : undefined,
    createdAt: String(row.created_at)
  };
}

function mapDreamRow(row: Record<string, unknown>): MemoryDreamRun {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tenantId: row.tenant_id != null ? String(row.tenant_id) : undefined,
    dreamDate: String(row.dream_date),
    status: String(row.status) as MemoryDreamRun['status'],
    factsCount: Number(row.facts_count ?? 0),
    summary: row.summary != null ? String(row.summary) : undefined,
    journal: row.journal != null ? String(row.journal) : undefined,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at != null ? String(row.finished_at) : undefined
  };
}
