import { randomUUID } from 'node:crypto';
import type { ModelStreamChunk, ModelTurnInput, ModelTurnResult } from '../types.js';

type Request = 'receipt' | 'observation' | 'history' | 'peer-history' | 'prepare-history' | 'format-receipt';
type Stream = (chunk: ModelStreamChunk) => void;
const ack = /(?:^|[。；;，,\n！!])\s*(?:然后)?(?:请)?(?:只|仅)(?:需)?回(?:复)?\s*(?:[“「"]收到[”」"]|收到)[。.!！]?\s*$/u;
// Restrict the automatic receipt to context declarations. Quoted edits to an
// arbitrary file or object are work requests even if the requested reply is short.
const contextClauses = [
  /^(?:切换到|切回|返回|开始)任务\s*[\p{L}\d_-]+$/u,
  /^(?:目标|约束|限制|决策)\s*[：:].+$/u,
  /^(?:更正|修正)?[\p{L}\d_-]+项目(?:立项)?$/u,
  /^(?:不得|禁止|仅限)[^。；，]+$/u,
  /^(?:(?:更正|修正)[\p{L}\d_-]+项目[：:])?(?:负责人|预算|期限|地点|代号|名称)(?:(?:为|是|改为|更正为)[\p{L}\d. _-]+|保持不变)$/u,
  /^把[“「"](?:负责人|预算|期限|地点|代号|名称)(?:为|是)[^”」"]+[”」"]改为[“「"](?:负责人|预算|期限|地点|代号|名称)(?:为|是)[^”」"]+[”」"]$/u
];

function receiptOnly(prefix: string): boolean {
  const clauses = prefix.split(/[。；;，,\n]/u).map(line => line.trim()).filter(Boolean);
  return clauses.every(clause => contextClauses.some(pattern => pattern.test(clause)));
}

const reported = /^(?:the )?(?:inspection|review|audit|check|search)\b[^.!?\n]*\b(?:found|identified|recorded|returned|reported)\b[^.!?\n]+[.!]?$/i;
const sourceNote = /^(?:keep (?:the|this) source available|(?:this|that|the) [\w -]+ is not a recommendation)$/i;
const reportedChinese = /^(?:此前|之前|刚才|上次|已经)(?:检查|核查|审计|检索|查询)[^，,。！？]*(?:发现|查到|得到|显示|结果为)[^，,。！？]+$/u;
const pastQuestion = /^(?:(?:what|which)\b[^?]*\b(?:did|was|were)\b[^?]*\?|(?:之前|此前|刚才|上次|先前|历史|检查|压缩前|当时)[^。！？]*(?:什么|哪个|多少|是什么)[？?]?)/i;
const identifier = /\b(?:identifier|id|code|number|reference)\b|编号|标识|代号/i;
const recallQualifier = /^(?:return (?:only )?(?:the |its )?[\w -]+|read (?:the |its )?(?:original )?source(?: if [\w ]+)?|只(?:回复|返回|给出)[^，；。]+)$/i;

// Narrow the conversational lane to a lookup. Mixed operational requests keep the normal tool loop.
const pastChats = /(?:earlier|previous|prior|past|old)\s+(?:chats?|conversations?|sessions?|messages?)|(?:之前|以前|先前|上次|过去|历史|旧)(?:的)?(?:聊天|对话|会话|消息)/i;
const lookupVerb = /^(?:(?:please\s+)?(?:search|look\s+up|find|read|retrieve|check|what|which|can you find)\b|(?:请|帮我|请帮我)?(?:查找|查一下|查阅|搜索|检索|翻查|找出|回看|读取)|(?:之前|上次|以前|旧)(?:的)?(?:会话|聊天|对话))/i;
const outputClause = /^(?:(?:please\s+)?(?:read|return|give|quote|show|identify)\b|(?:请)?(?:读取|只回|只返回|只给|引用|给出|返回))/i;
const operationalJoin = /\b(?:and|then)\s+(?!(?:read|return|give|quote|show|identify)\b)\w+|(?:然后|并且|再去|并)(?!读取|返回|给出|引用)/i;

function peerHistoryRequest(text: string): Request | undefined {
  if (/^(?:prepare|get ready) to (?:find|locate|look up|retrieve) (?:an? |the )?(?:earlier|previous|prior|past) [\w -]{1,80}[.!]?$/i.test(text) && !operationalJoin.test(text)) return 'prepare-history';
  if (!pastChats.test(text) || !lookupVerb.test(text) || operationalJoin.test(text)) return;
  const [, ...suffix] = text.split(/[.;!?。；！？\n]+/u).map(part => part.trim()).filter(Boolean);
  if (suffix.every(part => outputClause.test(part))) return 'peer-history';
}

export function botConversationRequest(text: string): Request | undefined {
  text = text.trim();
  const suffix = ack.exec(text);
  if (suffix) return receiptOnly(text.slice(0, suffix.index)) ? 'receipt' : 'format-receipt';
  const [first, ...rest] = text.split(/[.;；。！!\n]+/).map(line => line.trim()).filter(Boolean);
  if (first && (reported.test(first) || reportedChinese.test(first)) && rest.every(line => sourceNote.test(line))) return 'observation';
  const peer = peerHistoryRequest(text);
  if (peer) return peer;
  const question = pastQuestion.exec(text);
  if (!question || !identifier.test(question[0])) return undefined;
  if (!/inspection|audit|review|previous|earlier|history|last time|conversation|检查|之前|此前|刚才|上次|先前|历史|压缩前|当时/i.test(question[0])) return undefined;
  const qualifiers = text.slice(question[0].length).split(/[.;。；\n]+/).map(line => line.trim()).filter(Boolean);
  if (qualifiers.every(line => recallQualifier.test(line))) return 'history';
  return undefined;
}

const guidance = {
  'format-receipt': 'Follow the requested acknowledgment format exactly on success. Preserve required actions, approval requests and failure reporting.',
  receipt: 'Acknowledge this context update with exactly 收到.',
  observation: 'The user reported an existing observation. Its original wording is retained in this conversation. Acknowledge the information without initiating a new investigation.',
  'peer-history': 'Find the requested original in earlier authorized conversations of this Bot. Search by keyword without a session_id, then read the matching original reference. Use original text as evidence. If access fails or the original cannot be verified, report the gap. Follow the requested answer format.',
  'prepare-history': 'Acknowledge readiness to look up a previous decision. Ask for a keyword if needed.',
  history: 'Answer from the retained original conversation. Before answering, use history_search with a short distinctive phrase from the question, then history_read on the matching original user message or tool result. Look for the evidence predating the question. If the original is unavailable, say so. Follow the requested output format.'
};

export async function deliverConversationTurn(
  request: Request | undefined, input: ModelTurnInput, stream: Stream | undefined,
  deliver: (input: ModelTurnInput, stream?: Stream) => Promise<ModelTurnResult>, originalText?: string
): Promise<ModelTurnResult> {
  if (!request) return deliver(input, stream);
  const tools = conversationTools(request, input.tools);
  const fitted = { ...input, tools, systemPrompt: input.systemPrompt + '\n' + guidance[request] };
  if (request === 'peer-history') return deliverPeerHistory(fitted, stream, deliver, originalText);
  if (request === 'prepare-history') return deliver(fitted, stream);
  if (request === 'history') {
    const next = nextHistoryCall(fitted, originalText);
    if (next) return next;
  }
  if (request === 'history' || request === 'observation') return deliver(fitted, stream);
  // Hold visible text until it can be rendered identically in live and persisted views.
  // Tool and retry events still flow, and the original model request remains streaming.
  let done: Extract<ModelStreamChunk, { type: 'done' }> | undefined;
  const result = await deliver(fitted, stream && (chunk => {
    if (chunk.type === 'done') done = chunk;
    else if (chunk.type !== 'text_delta') stream(chunk);
  }));
  const parts = formatReceipt(request, result);
  for (const part of parts) if (part.type === 'text') stream?.({ type: 'text_delta', text: part.text });
  if (done) stream?.(done);
  return { ...result, assistantParts: parts };
}

function conversationTools(request: Request, tools: ModelTurnInput['tools']) {
  if (request === 'format-receipt') return tools;
  if (request === 'history' || request === 'peer-history') return tools.filter(tool => tool.name === 'history_search' || tool.name === 'history_read');
  return [];
}

function formatReceipt(request: Request, result: ModelTurnResult): ModelTurnResult['assistantParts'] {
  const parts = result.assistantParts;
  if (result.stopReason !== 'end' || result.truncated || !parts.some(part => part.type === 'text' && part.text.trim())) return parts;
  const text = parts.filter(part => part.type === 'text').map(part => part.text).join('').trim();
  if (request === 'format-receipt' && !/^(?:(?:只|仅)(?:需)?回(?:复)?\s*)?[“「"']?收到[”」"']?[。.!！\s]*$/u.test(text)) return parts;
  return [{ type: 'text', text: '收到' }];
}

/** Send read requests through the kernel so approvals, scope checks and transcript pairing still apply. */
function historyCall(input: ModelTurnInput, name: string, args: Record<string, unknown>): ModelTurnResult | undefined {
  if (!input.tools.some(tool => tool.name === name)) return undefined;
  return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: randomUUID(), name, input: args }] };
}

function soleOriginal(content: string, sessionId: string, before: number): string | undefined {
  try {
    const rows: unknown = JSON.parse(content).matches;
    if (!Array.isArray(rows)) return;
    const originals = rows.filter(row => row && row.sessionId === sessionId && row.seq < before && ['user', 'tool'].includes(row.role));
    if (originals.length === 1 && typeof originals[0].ref === 'string') return originals[0].ref;
  } catch { /* A shortened tool result can still be interpreted by the model. */ }
  return undefined;
}

function nextHistoryCall(input: ModelTurnInput, originalText?: string): ModelTurnResult | undefined {
  const messages = input.messages ?? [];
  const at = messages.findLastIndex(message => message.role === 'user');
  const question = messages[at];
  if (!question?.seq || !input.sessionId) return;
  const results = messages.slice(at + 1).flatMap(message => message.parts).filter(part => part.type === 'tool_result');
  const last = results.at(-1);
  if (last?.name === 'history_search' && last.ok) {
    const ref = soleOriginal(last.content, input.sessionId, question.seq);
    if (ref) return historyCall(input, 'history_read', { ref });
  }
  if (results.length) return;
  const text = originalText ?? question.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const phrase = /\b(?:what|which) (?:exact |specific )?([\w -]{1,80}?(?:identifier|code|number|reference|id)) (?:did|was|were)\b/i.exec(text);
  if (phrase) return historyCall(input, 'history_search', { query: phrase[1]!.trim(), session_id: input.sessionId });
  return undefined;
}

function peerQuery(text: string): string | undefined {
  const first = text.split(/[.;!?。；！？\n]/u)[0] ?? '';
  const quoted = /[“「"]([^”」"]{1,120})[”」"]/.exec(first);
  if (quoted) return quoted[1];
  return /\b(?:for|about)\s+([\w-]+(?: [\w-]+){0,6})$/i.exec(first)?.[1];
}

function uniquePeerReference(content: string, current?: string): string | undefined {
  try {
    const matches = JSON.parse(content).matches;
    if (!Array.isArray(matches)) return;
    const refs = new Set<string>();
    for (const row of matches) {
      if (row?.sessionId && row.sessionId !== current && ['user','tool'].includes(row.role) && typeof row.ref === 'string') refs.add(row.ref);
    }
    if (refs.size === 1) return refs.values().next().value;
  } catch { /* Excerpts may be truncated. Let the model select a visible source. */ }
  return undefined;
}

function finishedSource(name: string, content: string): boolean {
  if (name !== 'history_read') return false;
  try {
    const page = JSON.parse(content);
    return typeof page.nextOffset !== 'number';
  } catch {
    return false;
  }
}

function deliverPeerHistory(input: ModelTurnInput, stream: Stream | undefined,
  deliver: (input: ModelTurnInput, stream?: Stream) => Promise<ModelTurnResult>, originalText?: string) {
  const messages = input.messages ?? [];
  const at = messages.findLastIndex(message => message.role === 'user');
  const results = messages.slice(at + 1).flatMap(message => message.parts).filter(part => part.type === 'tool_result');
  const last = results.at(-1);
  if (last && !last.ok) {
    const text = /[\u3400-\u9fff]/u.test(originalText ?? '')
      ? '未能读取有权访问的历史原文，无法核实答案。'
      : 'I could not access the original conversation to verify the answer.';
    stream?.({ type: 'text_delta', text });
    stream?.({ type: 'done', stopReason: 'end' });
    return Promise.resolve<ModelTurnResult>({stopReason: 'end', assistantParts: [{ type: 'text', text }]});
  }
  if (last && (results.length >= 4 || finishedSource(last.name, last.content))) {
    return deliver({ ...input, tools: [] }, stream);
  }
  if (!last) {
    const query = peerQuery(originalText ?? '');
    const call = query && historyCall(input, 'history_search', {query});
    if (call) return call;
  } else if (last.name === 'history_search') {
    const ref = uniquePeerReference(last.content, input.sessionId);
    const call = ref && historyCall(input, 'history_read', {ref});
    if (call) return call;
  }
  return deliver(input, stream);
}
