import type { SidechatGrasp, SidechatMessage, SidechatStatus, SidechatThread } from '@ppeng/api-types';

export interface ThreadRow {
  id: string;
  session_id: string;
  message_id: string;
  agent_id: string;
  bot_id: string | null;
  ordinal: number;
  title: string;
  anchor: string;
  grasp: string;
  note: string | null;
  status: SidechatStatus;
  created: string;
  updated: string;
}

export interface TurnRow {
  id: string;
  thread_id: string;
  request_id: string;
  question: string;
  answer: string;
  status: SidechatStatus;
  error: string | null;
  run_id: string | null;
  created: string;
}

export const threadColumns = `t.id,t.session_id,t.message_id,t.agent_id,t.bot_id,t.ordinal,t.title,t.anchor,t.grasp,t.note,t.created,t.updated,
  (SELECT status FROM sidechat_turns WHERE thread_id=t.id ORDER BY n DESC LIMIT 1) AS status`;

export function readThread(row: ThreadRow): SidechatThread {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    botId: row.bot_id ?? undefined,
    ordinal: row.ordinal,
    title: row.title,
    anchor: JSON.parse(row.anchor),
    status: row.status,
    grasp: threadGrasp(row.grasp),
    note: threadNote(row.note),
    createdAt: row.created,
    updatedAt: row.updated
  };
}

function threadGrasp(value: string): SidechatGrasp {
  return value === 'mastered' ? 'mastered' : 'thinking';
}
function threadNote(value: string | null): string {
  return value ?? '';
}

export function readMessages(turn: TurnRow): SidechatMessage[] {
  const base = { requestId: turn.request_id, createdAt: turn.created };
  return [
    { ...base, id: turn.id + '_u', role: 'user', text: turn.question, status: 'complete' },
    {
      ...base,
      id: turn.id + '_a',
      role: 'assistant',
      text: turn.answer,
      status: turn.status,
      error: turn.error ?? undefined,
      generationId: turn.run_id ?? undefined
    }
  ];
}
