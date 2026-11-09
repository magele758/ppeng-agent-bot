import { randomUUID } from 'node:crypto';
import type { ModelStreamChunk, ModelTurnInput, ModelTurnResult } from '../types.js';

type Request = 'receipt' | 'observation' | 'history' | 'format-receipt';
type Stream = (chunk: ModelStreamChunk) => void;
const ack = /(?:^|[。；;，,\n！!])\s*(?:然后)?(?:请)?(?:只|仅)(?:需)?回(?:复)?\s*(?:[“「"]收到[”」"]|收到)[。.!！]?\s*$/u;
const contextClause = /^(?:(?:切换到|切回|返回|开始)任务\s*[\p{L}\d_-]+|(?:目标|约束|限制|决策)\s*[：:].+|(?:更正|修正)?[\p{L}\d_-]+项目(?:立项)?|(?:不得|禁止|仅限)[^。；，]+|(?:负责人|预算|期限|地点|代号|名称)(?:(?:为|是|改为|更正为)[\p{L}\d. _-]+|保持不变)|把[“「"][^”」"]+[”」"]改为[“「"][^”」"]+[”」"])$/u;

function receiptOnly(text: string): boolean {
 const suffix = ack.exec(text);
 if (!suffix) return false;
 const clauses = text.slice(0,suffix.index).split(/[。；;，,\n]/u).map(line=>line.trim()).filter(Boolean);
 return clauses.every(clause=>contextClause.test(clause) || /^(?:更正|修正)[\p{L}\d_-]+项目[：:](?:负责人|预算)(?:改为|更正为)[\p{L}\d. _-]+$/u.test(clause));
}

const reported = /^(?:the )?(?:inspection|review|audit|check|search)\b[^.!?\n]*\b(?:found|identified|recorded|returned|reported)\b[^.!?\n]+[.!]?$/i;
const sourceNote = /^(?:keep (?:the|this) source available|(?:this|that|the) [\w -]+ is not a recommendation)$/i;
const reportedChinese = /^(?:此前|之前|刚才|上次)?(?:检查|核查|审计|检索|查询).*(?:发现|查到|得到|显示|结果为)[^。！？]+$/u;
const pastQuestion = /^(?:(?:what|which)\b[^?]*\b(?:did|was|were)\b[^?]*\?|(?:之前|此前|刚才|上次|先前|历史|检查|压缩前|当时)[^。！？]*(?:什么|哪个|多少|是什么)[？?]?)/i;
const identifier = /\b(?:identifier|id|code|number|reference)\b|编号|标识|代号/i;
const recallQualifier = /^(?:return (?:only )?(?:the |its )?[\w -]+|read (?:the |its )?(?:original )?source(?: if [\w ]+)?|只(?:回复|返回|给出)[^，；。]+)$/i;

export function botConversationRequest(text: string): Request | undefined {
 text = text.trim();
 if (ack.test(text)) return receiptOnly(text) ? 'receipt' : 'format-receipt';
 const [first,...rest] = text.split(/[.;；。！!\n]+/).map(line=>line.trim()).filter(Boolean);
 if (first && (reported.test(first) || reportedChinese.test(first)) && rest.every(line=>sourceNote.test(line))) return 'observation';
 const question = pastQuestion.exec(text);
 if (!question || !identifier.test(question[0])) return undefined;
 const qualifiers = text.slice(question[0].length).split(/[.;。；\n]+/).map(line=>line.trim()).filter(Boolean);
 if (qualifiers.every(line=>recallQualifier.test(line))) return 'history';
 return undefined;
}

const guidance = {
 'format-receipt':'Follow the requested acknowledgment format exactly on success. Preserve required actions, approval requests and failure reporting.',
 receipt:'Acknowledge this context update with exactly 收到.',
 observation:'The user reported an existing observation. Its original wording is retained in this conversation. Acknowledge the information without initiating a new investigation.',
 history:'Answer from the retained original conversation. Before answering, use history_search with a short distinctive phrase from the question, then history_read on the matching original user message or tool result. Look for the evidence predating the question. If the original is unavailable, say so. Follow the requested output format.'
};

export async function deliverConversationTurn(
 request: Request | undefined, input: ModelTurnInput, stream: Stream | undefined,
 deliver: (input: ModelTurnInput, stream?: Stream) => Promise<ModelTurnResult>, originalText?: string
): Promise<ModelTurnResult> {
 if (!request) return deliver(input,stream);
 const tools = conversationTools(request,input.tools);
 const fitted = {...input,tools,systemPrompt:input.systemPrompt+'\n'+guidance[request]};
 if (request === 'history') {
   const next=nextHistoryCall(fitted,originalText);
   if (next) return next;
 }
 if (request === 'history' || request === 'observation') return deliver(fitted,stream);
 // Hold visible text until it can be rendered identically in live and persisted views.
 // Tool and retry events still flow, and the original model request remains streaming.
 let done: Extract<ModelStreamChunk,{type:'done'}> | undefined;
 const result = await deliver(fitted,stream && (chunk=>{
   if (chunk.type==='done') done=chunk;
   else if (chunk.type!=='text_delta') stream(chunk);
 }));
 const parts = formatReceipt(request,result);
 for (const part of parts) if (part.type==='text') stream?.({type:'text_delta',text:part.text});
 if (done) stream?.(done);
 return {...result,assistantParts:parts};
}

function conversationTools(request: Request, tools: ModelTurnInput['tools']) {
 if (request==='format-receipt') return tools;
 if (request==='history') return tools.filter(tool=>tool.name==='history_search' || tool.name==='history_read');
 return [];
}

function formatReceipt(request: Request, result: ModelTurnResult): ModelTurnResult['assistantParts'] {
 const parts=result.assistantParts;
 if (result.stopReason!=='end' || result.truncated || !parts.some(part=>part.type==='text' && part.text.trim())) return parts;
 const text=parts.filter(part=>part.type==='text').map(part=>part.text).join('').trim();
 if (request==='format-receipt' && !/^(?:(?:只|仅)(?:需)?回(?:复)?\s*)?[“「"']?收到[”」"']?[。.!！\s]*$/u.test(text)) return parts;
 return [{type:'text',text:'收到'}];
}

/** Send read requests through the kernel so approvals, scope checks and transcript pairing still apply. */
function historyCall(input: ModelTurnInput, name: string, args: Record<string,unknown>): ModelTurnResult | undefined {
 if (!input.tools.some(tool=>tool.name===name)) return undefined;
 return {stopReason:'tool_use',assistantParts:[{type:'tool_call',toolCallId:randomUUID(),name,input:args}]};
}

function soleOriginal(content: string, sessionId: string, before: number): string | undefined {
 try {
   const rows: unknown = JSON.parse(content).matches;
   if (!Array.isArray(rows)) return;
   const originals = rows.filter(row=>row && row.sessionId===sessionId && row.seq<before && ['user','tool'].includes(row.role));
   if (originals.length===1 && typeof originals[0].ref==='string') return originals[0].ref;
 } catch { /* A shortened tool result can still be interpreted by the model. */ }
 return undefined;
}

function nextHistoryCall(input: ModelTurnInput, originalText?: string): ModelTurnResult | undefined {
 const messages=input.messages ?? [];
 const at=messages.findLastIndex(message=>message.role==='user');
 const question=messages[at];
 if (!question?.seq || !input.sessionId) return;
 const results=messages.slice(at+1).flatMap(message=>message.parts).filter(part=>part.type==='tool_result');
 const last=results.at(-1);
 if (last?.name==='history_search' && last.ok) {
   const ref=soleOriginal(last.content,input.sessionId,question.seq);
   if (ref) return historyCall(input,'history_read',{ref});
 }
 if (results.length) return;
 const text=originalText ?? question.parts.filter(part=>part.type==='text').map(part=>part.text).join('\n');
 const phrase=/\b(?:what|which) (?:exact |specific )?([\w -]{1,80}?(?:identifier|code|number|reference|id)) (?:did|was|were)\b/i.exec(text);
 if (phrase) return historyCall(input,'history_search',{query:phrase[1]!.trim(),session_id:input.sessionId});
 return undefined;
}
