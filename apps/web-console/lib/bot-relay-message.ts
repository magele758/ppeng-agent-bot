/**
 * Bot-to-Bot traffic the runtime writes into a Bot session as a user turn:
 * `Message from <name> / <bot_id>[ (from room <id>)]: <body>` (core bot-work.ts / message-agent.ts).
 * The body is a delegated task, a delegated-task result, or a plain message.
 */
export type BotRelayKind = 'task' | 'result' | 'message';

export type BotRelayMessage = {
  senderName: string;
  senderId: string;
  kind: BotRelayKind;
  status?: string;
  summary: string;
  text: string;
};

const HEADER = /^Message from (.+?) \/ (bot_[A-Za-z0-9_-]+)(?: \(from room [^)\n]+\))?: /;
const TASK = /^Delegated task btask_[A-Za-z0-9_-]+: /;
const RESULT = /^Task btask_[A-Za-z0-9_-]+ ([a-z_]+): /;
const SUMMARY_MAX = 80;

function firstLine(body: string): string {
  const line = body.split('\n').find((row) => row.trim()) ?? '';
  const trimmed = line.trim();
  return trimmed.length > SUMMARY_MAX ? `${trimmed.slice(0, SUMMARY_MAX)}…` : trimmed;
}

function classify(body: string): Pick<BotRelayMessage, 'kind' | 'status'> & { rest: string } {
  const task = TASK.exec(body);
  if (task) return { kind: 'task', rest: body.slice(task[0].length) };
  const result = RESULT.exec(body);
  if (result) return { kind: 'result', status: result[1], rest: body.slice(result[0].length) };
  return { kind: 'message', rest: body };
}

export function parseBotRelayMessage(role: string, text: string): BotRelayMessage | null {
  if (role !== 'user') return null;
  const header = HEADER.exec(text);
  if (!header) return null;
  const { rest, ...kind } = classify(text.slice(header[0].length));
  return { senderName: header[1]!, senderId: header[2]!, ...kind, summary: firstLine(rest), text };
}
