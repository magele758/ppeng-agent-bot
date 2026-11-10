/** Cross-session message body search. Callers pass sessions the caller may already see. */

const SNIPPET_PAD = 48;

export type MessageSearchHit = {
  sessionId: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: string;
  sessionTitle: string;
  agentId: string;
};

export type MessageSearchSession = {
  id: string;
  title?: string;
  agentId?: string;
};

export type MessageSearchDb = {
  prepare(sql: string): {
    all(...args: ReadonlyArray<string | number>): unknown[];
  };
};

type HitRow = {
  messageId: string;
  sessionId: string;
  role: string;
  partsJson: string;
  createdAt: string;
};

const SEARCH_SQL = `
SELECT id AS messageId,
       session_id AS sessionId,
       role,
       parts_json AS partsJson,
       created_at AS createdAt
FROM session_messages
WHERE session_id IN (SELECT value FROM json_each(?))
  AND (surface_op IS NULL OR surface_op != 'hide')
  AND EXISTS (
    SELECT 1
    FROM json_each(parts_json) AS part
    WHERE instr(lower(COALESCE(CAST(json_extract(part.value, '$.text') AS TEXT), '')), ?) > 0
       OR instr(lower(COALESCE(CAST(json_extract(part.value, '$.content') AS TEXT), '')), ?) > 0
  )
ORDER BY created_at DESC, seq DESC, id DESC
LIMIT ?`;

export function parseMessageSearchLimit(raw: string | null | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 1) return 20;
  return Math.min(50, Math.floor(parsed));
}

export function searchSessionMessageBodies(
  db: MessageSearchDb,
  sessions: readonly MessageSearchSession[],
  q: string,
  limit: number
): MessageSearchHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle || sessions.length === 0) return [];
  const rows = db.prepare(SEARCH_SQL).all(JSON.stringify(sessions.map((session) => session.id)), needle, needle, limit);
  return rows.flatMap((row) => hitFromRow(row as HitRow, indexSessions(sessions), needle));
}

function indexSessions(sessions: readonly MessageSearchSession[]): Map<string, MessageSearchSession> {
  return new Map(sessions.map((session) => [session.id, session]));
}

function hitFromRow(row: HitRow, sessions: Map<string, MessageSearchSession>, needle: string): MessageSearchHit[] {
  const session = sessions.get(row.sessionId);
  const snippet = session && snippetAround(messageBodyText(row.partsJson), needle);
  if (!session || !snippet) return [];
  return [toHit(row, session, snippet)];
}

function toHit(row: HitRow, session: MessageSearchSession, snippet: string): MessageSearchHit {
  return {
    sessionId: row.sessionId,
    messageId: row.messageId,
    role: row.role,
    snippet,
    createdAt: row.createdAt,
    sessionTitle: session.title ?? '',
    agentId: session.agentId ?? ''
  };
}

function messageBodyText(partsJson: string): string {
  return parseParts(partsJson).map(textOf).filter(Boolean).join('\n');
}

function parseParts(partsJson: string): unknown[] {
  try {
    const parsed = JSON.parse(partsJson) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function textOf(part: unknown): string {
  if (!isRecord(part)) return '';
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  return contentOf(part);
}

function contentOf(part: Record<string, unknown>): string {
  if (part.type !== 'tool_result' || typeof part.content !== 'string') return '';
  return part.content;
}

function isRecord(part: unknown): part is Record<string, unknown> {
  return Boolean(part) && typeof part === 'object';
}

function snippetAround(text: string, needle: string): string | undefined {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return undefined;
  return clipSnippet(text, at, at + needle.length);
}

function clipSnippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_PAD);
  const to = Math.min(text.length, end + SNIPPET_PAD);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return prefix + collapseWs(text.slice(from, to)) + suffix;
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
