import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { DaydreamCandidate } from './types.js';

type EffectCandidate = Pick<DaydreamCandidate, 'kind' | 'content' | 'evidenceIds'>;

export function daydreamEffectKey(tenantId: string | undefined, botId: string, candidate: EffectCandidate): string {
  return createHash('sha256').update(JSON.stringify([tenantId, botId, candidate.kind, candidate.content, candidate.evidenceIds.slice().sort()])).digest('hex');
}

export interface SkillReview {
  botId: string;
  runId: string;
  outputIndex: number;
  artifactId: string;
}

/** Project the fields needed for proposal reconciliation and share receipts. Legacy writers update the projection in the same transaction as the run. */
export function installDaydreamPollStore(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bot_daydream_poll_outputs'").get()) return;
  db.exec('SAVEPOINT daydream_poll_install');
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS bot_daydream_schedule ON bot_daydream_runs(bot_id, json_extract(body,'$.status'), date, dedupe, id);
      CREATE TABLE IF NOT EXISTS bot_daydream_poll_outputs(
        run_id TEXT NOT NULL, output_index INTEGER NOT NULL, bot_id TEXT NOT NULL, tenant_id TEXT,
        status TEXT NOT NULL, artifact_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT, evidence_ids TEXT,
        PRIMARY KEY(run_id,output_index));
      CREATE INDEX IF NOT EXISTS bot_daydream_output_status ON bot_daydream_poll_outputs(status,bot_id,run_id);
      CREATE VIEW IF NOT EXISTS bot_daydream_output_refs AS
        SELECT r.id AS run_id, o.key AS output_index, r.bot_id, r.tenant_id,
               o.value ->> '$.status' AS status, o.value ->> '$.artifactId' AS artifact_id,
               o.value ->> '$.candidate.kind' AS kind,
               CASE WHEN o.value ->> '$.status'='saved' THEN o.value ->> '$.candidate.content' END AS content,
               CASE WHEN o.value ->> '$.status'='saved' THEN o.value -> '$.candidate.evidenceIds' END AS evidence_ids
        FROM bot_daydream_runs AS r, json_each(r.body,'$.outputs') AS o
        WHERE o.value ->> '$.artifactId' <> '' AND (
          (o.value ->> '$.status'='pending' AND o.value ->> '$.candidate.kind'='skill') OR
          (o.value ->> '$.status'='saved' AND o.value ->> '$.candidate.shareable'=1));
      CREATE TRIGGER IF NOT EXISTS bot_daydream_poll_insert AFTER INSERT ON bot_daydream_runs BEGIN
        DELETE FROM bot_daydream_poll_outputs WHERE run_id=NEW.id;
        INSERT OR REPLACE INTO bot_daydream_poll_outputs SELECT * FROM bot_daydream_output_refs WHERE run_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS bot_daydream_poll_update AFTER UPDATE OF id,bot_id,tenant_id,body ON bot_daydream_runs BEGIN
        DELETE FROM bot_daydream_poll_outputs WHERE run_id=OLD.id;
        INSERT OR REPLACE INTO bot_daydream_poll_outputs SELECT * FROM bot_daydream_output_refs WHERE run_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS bot_daydream_poll_delete AFTER DELETE ON bot_daydream_runs BEGIN
        DELETE FROM bot_daydream_poll_outputs WHERE run_id=OLD.id;
      END;
      INSERT OR REPLACE INTO bot_daydream_poll_outputs SELECT * FROM bot_daydream_output_refs;
      RELEASE daydream_poll_install;
    `);
  } catch (error) {
    db.exec('ROLLBACK TO daydream_poll_install; RELEASE daydream_poll_install');
    throw error;
  }
}

export function pendingDaydreamSkills(db: DatabaseSync): Map<string, SkillReview[]> {
  // The review window matches the history exposed by listRuns. Limit run IDs before loading any bodies.
  const rows = db.prepare(`
    SELECT p.bot_id AS botId, p.run_id AS runId, p.output_index AS outputIndex, p.artifact_id AS artifactId
    FROM bot_daydream_poll_outputs AS p JOIN bot_daydream_runs AS r ON r.id=p.run_id
    WHERE p.status='pending' AND p.run_id IN (
      SELECT id FROM bot_daydream_runs WHERE bot_id=p.bot_id ORDER BY date DESC,rowid DESC LIMIT 100)
    ORDER BY p.bot_id,r.date DESC,r.rowid DESC,p.output_index
  `).all() as unknown as SkillReview[];
  const reviews = new Map<string, SkillReview[]>();
  for (const row of rows) {
    const group = reviews.get(row.botId) ?? [];
    group.push(row);
    reviews.set(row.botId, group);
  }
  return reviews;
}

function unsharedDaydreamRuns(db: DatabaseSync, botId: string, oldest: string, newest: string): Set<string> {
  const candidates = db.prepare(`
    SELECT r.dedupe,p.tenant_id,p.kind,p.content,p.evidence_ids FROM bot_daydream_runs AS r INDEXED BY bot_daydream_schedule
    JOIN bot_daydream_poll_outputs AS p ON p.run_id=r.id
    WHERE r.bot_id=? AND json_extract(r.body,'$.status') IN ('completed','cancelled') AND r.date BETWEEN ? AND ?
      AND r.dedupe=(r.bot_id || ':' || r.date) AND p.bot_id=r.bot_id AND p.status='saved'
  `).all(botId, oldest, newest) as {dedupe: string; tenant_id: string | null; kind: EffectCandidate['kind']; content: string; evidence_ids: string}[];
  const receipt = db.prepare('SELECT 1 FROM bot_daydream_effects WHERE key=?');
  const missing = new Set<string>();
  for (const item of candidates) {
    const key = daydreamEffectKey(item.tenant_id ?? undefined, botId, {...item, evidenceIds: JSON.parse(item.evidence_ids)});
    if (!receipt.get('shared:' + key)) missing.add(item.dedupe);
  }
  return missing;
}

export function dueDaydreamWork(db: DatabaseSync, botId: string, dates: string[], sharing: boolean) {
  // This covering index projects status even for records written before the polling index existed.
  const pending = db.prepare(`
    SELECT id,date,dedupe FROM bot_daydream_runs INDEXED BY bot_daydream_schedule
    WHERE bot_id=? AND json_extract(body,'$.status') IN ('partial','queued','running','failed') ORDER BY date,rowid
  `).all(botId) as {id: string; date: string; dedupe: string}[];
  if (!dates.length) return {pending, dates};

  const oldest = dates[0]!;
  const newest = dates[dates.length - 1]!;
  const unshared = sharing ? unsharedDaydreamRuns(db, botId, oldest, newest) : new Set<string>();
  const resuming = new Set(pending.map(row => row.dedupe));
  const keys = dates.map(date => botId + ':' + date);
  const existing = db.prepare(`SELECT dedupe FROM bot_daydream_runs WHERE dedupe IN (${keys.map(() => '?').join(',')})`).all(...keys);
  const settled = new Set(existing.map(row => row.dedupe));
  return {pending, dates: dates.filter((_, i) => !settled.has(keys[i]!) || unshared.has(keys[i]!) && !resuming.has(keys[i]!))};
}
