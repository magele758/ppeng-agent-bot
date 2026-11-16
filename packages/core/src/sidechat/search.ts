import type { DatabaseSync } from 'node:sqlite';
import type { SidechatMatch, SidechatSearchHit } from '@ppeng/api-types';
import { readThread, threadColumns, type ThreadRow } from './rows.js';

export interface SearchOptions {
  query?: string;
  exactQuote?: string;
  excludeSessionId?: string;
  sessionId?: string;
  botId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

type HitRow = ThreadRow & {
  session_title: string;
  field: SidechatMatch['field'] | null;
  excerpt: string | null;
  match_id: string | null;
};

const filters = [
  ['exactQuote', "lower(trim(json_extract(t.anchor,'$.quote')))=lower(trim(?))"],
  ['excludeSessionId', 't.session_id!=?'],
  ['sessionId', 't.session_id=?'],
  ['botId', 't.bot_id=?'],
  ['from', 't.updated>=?'],
  ['to', 't.updated<=?']
] as const;

function selection(owner: string, visible: readonly string[], opts: SearchOptions) {
  const where = ['t.owner=?', 't.session_id IN (SELECT value FROM json_each(?))'];
  const args = [owner, JSON.stringify(visible)];
  for (const [name, clause] of filters) {
    const value = opts[name];
    if (value) {
      where.push(clause);
      args.push(value);
    }
  }
  return {
    sql: `SELECT ${threadColumns}, s.title AS session_title
          FROM sidechat_threads t JOIN sessions s ON s.id = t.session_id
          WHERE ${where.join(' AND ')}`,
    args
  };
}

function matching(query: string, hasFts: boolean) {
  const args = [query, query, query];
  let condition = 'instr(lower(c.text),lower(?))>0';
  if (hasFts && Array.from(query).length >= 3 && !query.includes('\0')) {
    condition += ' AND c.docid IN (SELECT rowid FROM sidechat_fts WHERE sidechat_fts MATCH ?)';
    args.push('"' + query.replaceAll('"', '""') + '"');
  }
  const sql = `SELECT c.*, instr(lower(c.text), lower(?)) AS pos,
                      CASE WHEN c.field = 'quote' AND lower(c.text) = lower(?) THEN 0
                           WHEN c.field = 'title' THEN 1
                           WHEN c.field = 'quote' THEN 2
                           ELSE 3 END AS rank
               FROM sidechat_corpus c JOIN scope ON scope.id = c.thread_id
               WHERE ${condition}`;
  return { sql, args };
}

function group(rows: HitRow[]): SidechatSearchHit[] {
  const hits = new Map<string, SidechatSearchHit>();
  for (const row of rows) {
    let hit = hits.get(row.id);
    if (!hit) {
      hit = { thread: readThread(row), sessionTitle: row.session_title, matches: [] };
      hits.set(row.id, hit);
    }
    if (row.field) {
      hit.matches.push({
        field: row.field,
        snippet: row.excerpt ?? '',
        messageId: row.match_id ?? undefined
      });
    }
  }
  return [...hits.values()];
}

export function searchSidechats(
  db: DatabaseSync,
  owner: string,
  visible: readonly string[],
  opts: SearchOptions,
  hasFts: boolean
): SidechatSearchHit[] {
  if (visible.length === 0) return [];
  const scope = selection(owner, visible, opts);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 201));
  const offset = Math.max(0, opts.offset ?? 0);
  const query = opts.query?.trim();
  if (!query) {
    const field = opts.exactQuote ? "'quote'" : 'NULL';
    const rows = db
      .prepare(
        `WITH scope AS (${scope.sql})
         SELECT *, ${field} AS field, json_extract(anchor,'$.quote') AS excerpt, NULL AS match_id
         FROM scope ORDER BY updated DESC, id LIMIT ? OFFSET ?`
      )
      .all(...scope.args, limit, offset);
    return group(rows as unknown as HitRow[]);
  }
  const matched = matching(query, hasFts);
  const rows = db
    .prepare(
      `WITH scope AS (${scope.sql}), matched AS (${matched.sql}),
       page AS (
         SELECT scope.*, min(matched.rank) AS best
         FROM scope JOIN matched ON matched.thread_id = scope.id
         GROUP BY scope.id ORDER BY best, scope.updated DESC, scope.id LIMIT ? OFFSET ?
       )
       SELECT page.*, matched.field, matched.message_id AS match_id,
              substr(matched.text, max(1, matched.pos - 36), length(?) + 72) AS excerpt
       FROM page JOIN matched ON matched.thread_id = page.id
       ORDER BY page.best, page.updated DESC, page.id, matched.rank, matched.docid`
    )
    .all(...scope.args, ...matched.args, limit, offset, query);
  return group(rows as unknown as HitRow[]);
}
