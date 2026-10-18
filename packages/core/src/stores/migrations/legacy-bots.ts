/**
 * Data fixes for state written before bot isolation (schema v22).
 *
 * v21 added agent_memory.agent_id but left every old row NULL, so memory a Bot wrote
 * earlier landed on the shared user.memory pool that every agent reads. Rows whose
 * session resolves to a Bot are moved into that Bot's namespace with the same rules
 * the runtime uses today. Rows with no session_id cannot be attributed and stay shared.
 */

import type { DatabaseSync } from 'node:sqlite';
import { LEGACY_BOT_BYPASS_META, isDefaultAssignedBypass } from '../../bots/legacy-bypass.js';
import {
  resolveBotMemoryAgentId,
  type BotMemoryLookup,
  type BotMemorySession
} from '../../memory/bot-memory-scope.js';

interface SessionRow {
  id: string;
  agent_id: string;
  mode: string;
  parent_session_id: string | null;
  metadata_json: string;
}

interface MemoryRow {
  id: string;
  scope: string;
  namespace: string;
  key: string;
  user_id: string | null;
  tenant_id: string | null;
  session_id: string;
  updated_at: string;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rawBotLookup(db: DatabaseSync): Required<Pick<BotMemoryLookup, 'getBot' | 'listBots' | 'getSession'>> {
  const bots = db.prepare(`SELECT id, agent_id AS agentId FROM bots`).all() as Array<{
    id: string;
    agentId: string;
  }>;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const sessionStmt = db.prepare(
    `SELECT id, agent_id, mode, parent_session_id, metadata_json FROM sessions WHERE id = ?`
  );
  return {
    getBot: (id) => byId.get(id),
    listBots: () => bots,
    getSession: (id): BotMemorySession | undefined => {
      const row = sessionStmt.get(id) as SessionRow | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        agentId: row.agent_id,
        mode: row.mode,
        parentSessionId: row.parent_session_id ?? undefined,
        metadata: parseMetadata(row.metadata_json)
      };
    }
  };
}

const isSessionScope = (scope: string) => scope === 'session.scratch' || scope === 'session.long';

/** Keep only the newer of a legacy row and a same-key row already in the Bot namespace. */
function dropOlderDuplicate(db: DatabaseSync, row: MemoryRow, agentId: string, hasEmbeddings: boolean): boolean {
  const twin = db
    .prepare(
      `SELECT id, updated_at FROM agent_memory
       WHERE agent_id = ? AND scope = ? AND namespace = ? AND key = ?
         AND user_id IS ? AND tenant_id IS ? AND session_id IS ? AND id != ?`
    )
    .get(agentId, row.scope, row.namespace, row.key, row.user_id, row.tenant_id, row.session_id, row.id) as
    | { id: string; updated_at: string }
    | undefined;
  if (!twin) return false;
  const loserId = twin.updated_at >= row.updated_at ? row.id : twin.id;
  if (hasEmbeddings) db.prepare(`DELETE FROM agent_memory_embedding WHERE memory_id = ?`).run(loserId);
  db.prepare(`DELETE FROM agent_memory WHERE id = ?`).run(loserId);
  return loserId === row.id;
}

export function backfillBotMemoryAgentIds(db: DatabaseSync): void {
  if (!tableExists(db, 'bots') || !tableExists(db, 'agent_memory') || !tableExists(db, 'sessions')) return;
  const lookup = rawBotLookup(db);
  const hasEmbeddings = tableExists(db, 'agent_memory_embedding');
  const owners = new Map<string, string | undefined>();
  const ownerOf = (sessionId: string) => {
    if (!owners.has(sessionId)) {
      const session = lookup.getSession(sessionId);
      owners.set(sessionId, session ? resolveBotMemoryAgentId(session, lookup) : undefined);
    }
    return owners.get(sessionId);
  };
  const rows = db
    .prepare(
      `SELECT id, scope, namespace, key, user_id, tenant_id, session_id, updated_at
       FROM agent_memory WHERE agent_id IS NULL AND session_id IS NOT NULL`
    )
    .all() as unknown as MemoryRow[];
  const stamp = db.prepare(`UPDATE agent_memory SET agent_id = ? WHERE id = ?`);
  for (const row of rows) {
    const agentId = ownerOf(row.session_id);
    if (!agentId) continue;
    if (!isSessionScope(row.scope) && dropOlderDuplicate(db, row, agentId, hasEmbeddings)) continue;
    stamp.run(agentId, row.id);
  }
}

/** Stamp Bot canonical sessions whose bypass came from the old default. */
export function flagLegacyBypassBots(db: DatabaseSync): void {
  if (!tableExists(db, 'bots') || !tableExists(db, 'sessions')) return;
  const rows = db
    .prepare(
      `SELECT s.id, s.metadata_json FROM bots b JOIN sessions s ON s.id = b.canonical_session_id`
    )
    .all() as Array<{ id: string; metadata_json: string }>;
  const update = db.prepare(`UPDATE sessions SET metadata_json = ? WHERE id = ?`);
  for (const row of rows) {
    const metadata = parseMetadata(row.metadata_json);
    if (!isDefaultAssignedBypass(metadata) || metadata[LEGACY_BOT_BYPASS_META] === true) continue;
    update.run(JSON.stringify({ ...metadata, [LEGACY_BOT_BYPASS_META]: true }), row.id);
  }
}
