import type { SqliteStateStore } from '../../storage.js';
import { goalNoticeVersion } from './runtime-host.js';
import type { BotGoal } from './types.js';

type GoalRow = Pick<BotGoal, 'id' | 'sessionId' | 'status' | 'revision'> & {
 botId: string;
 blockedReason: string | null;
 receipt: string | null;
 running: number;
 drainingWait: number;
};

export interface GoalSchedulerWork {
 botId: string;
 sessionId: string;
 runningOrDraining: Set<string>;
 goalIds: Set<string>;
 active: boolean;
}

/** Project only scheduling fields. Historical events, worker output and unrelated session metadata stay in SQLite. */
export function goalSchedulerWork(store: SqliteStateStore): GoalSchedulerWork[] {
 const rows = store.db.prepare(`
  WITH running AS MATERIALIZED (
   SELECT DISTINCT s.key AS snapshot, e.value ->> '$.goalId' AS goal_id
   FROM daemon_control AS s, json_each(s.value_json, '$.executions') AS e
   WHERE s.key GLOB 'bot_goals:*' AND e.value ->> '$.status' = 'running'
  )
  SELECT substr(s.key, 11) AS botId, g.value ->> '$.sessionId' AS sessionId, g.value ->> '$.id' AS id,
         g.value ->> '$.status' AS status, g.value ->> '$.revision' AS revision, g.value ->> '$.blockedReason' AS blockedReason,
         json_extract(n.value_json, '$') AS receipt, r.goal_id IS NOT NULL AS running,
         (g.value ->> '$.draining' = 1 AND g.value ->> '$.wait' IS NOT NULL) AS drainingWait
  FROM daemon_control AS s, json_each(s.value_json, '$.goals') AS g
  LEFT JOIN running AS r ON r.snapshot = s.key AND r.goal_id = g.value ->> '$.id'
  LEFT JOIN daemon_control AS n ON n.key = 'bot.goal-notice:' || (g.value ->> '$.id')
  WHERE s.key GLOB 'bot_goals:*'
 `).all() as unknown as GoalRow[];
 const scopes = new Map<string, GoalSchedulerWork>();
 for (const row of rows) {
  const active = !!(row.running || row.drainingWait || row.status === 'waiting' || row.status === 'queued');
  if (!active && !needsNotice(row)) continue;
  const key = JSON.stringify([row.botId, row.sessionId]);
  let work = scopes.get(key);
  if (!work) {
   work = {botId: row.botId, sessionId: row.sessionId, runningOrDraining: new Set(), goalIds: new Set(), active: false};
   scopes.set(key, work);
  }
  work.active ||= active;
  work.goalIds.add(row.id);
  if (row.running || row.drainingWait) work.runningOrDraining.add(row.id);
 }
 return [...scopes.values()];
}

function needsNotice(row: GoalRow): boolean {
 const version = goalNoticeVersion(row);
 return version !== undefined && version !== row.receipt;
}
