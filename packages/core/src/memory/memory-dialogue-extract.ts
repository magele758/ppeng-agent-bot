/**
 * Turn-end semantic extract: heuristic first, optional LLM, then semantic merge.
 * Fail-soft — never blocks the main loop.
 */

import { isLowValueSemanticContent, isTrivialChitchat, sanitizeSemanticFactContent } from './memory-gate.js';
import type { SemanticCategory } from './memory-semantic-merge.js';

const SEMANTIC_SIGNAL_RE =
  /叫|称呼|名字|姓名|我是|我叫|职业|就职|公司|偏好|记住|以后|从现在|别叫|不要叫|助手|你叫|改成|换成|习惯|风格|说中文|说英文|Markdown|markdown/;

export interface DialogueExtractFact {
  category: SemanticCategory;
  content: string;
  importance: number;
}

export interface DialogueExtractResult {
  facts: DialogueExtractFact[];
}

export function isTemporaryMemoryInstruction(text: string): boolean {
  return /(?:仅|只)(?:在)?(?:这次|本次|当前)|本次(?:任务|对话|回复)|临时(?:要求|偏好|使用)|不要(?:保存|记住)|(?:for|this)\s+(?:this\s+)?(?:task|turn|time)\s+only|do\s+not\s+(?:remember|save)/i.test(text);
}

export function shouldAttemptDialogueExtract(userText: string): boolean {
  const t = (userText || '').trim();
  if (!t || t.length < 2) return false;
  if (isTemporaryMemoryInstruction(t)) return false;
  if (isTrivialChitchat(t)) return false;
  if (isLowValueSemanticContent(t)) return false;
  return SEMANTIC_SIGNAL_RE.test(t);
}

export function parseDialogueExtractJson(text: string): DialogueExtractResult {
  const raw = (text || '').trim().replace(/^```json\s*|```$/g, '').trim();
  if (!raw) return { facts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { facts: [] };
  }
  const facts = Array.isArray((parsed as { facts?: unknown }).facts)
    ? ((parsed as { facts: unknown[] }).facts)
    : [];
  const allowed = new Set(['fact', 'preference', 'entity', 'concept']);
  const out: DialogueExtractFact[] = [];
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    const row = f as Record<string, unknown>;
    const category = String(row.category || '').trim();
    const content = String(row.content || '').trim();
    if (!allowed.has(category) || content.length < 4) continue;
    if (/tool_call|<invoke|密钥|password|token\s*=/i.test(content)) continue;
    const cleaned = sanitizeSemanticFactContent(content);
    if (!cleaned) continue;
    const importance =
      typeof row.importance === 'number' && row.importance >= 0.4 && row.importance <= 1
        ? row.importance
        : 0.7;
    out.push({
      category: category as SemanticCategory,
      content: cleaned.slice(0, 400),
      importance
    });
    if (out.length >= 5) break;
  }
  return { facts: out };
}

/** Cheap regex extract so tests / no-LLM path still persist identity facts. */
export function heuristicExtractDialogueFacts(userText: string): DialogueExtractFact[] {
  if (!shouldAttemptDialogueExtract(userText)) return [];
  const t = userText.trim();
  const facts: DialogueExtractFact[] = [];
  const push = (category: SemanticCategory, content: string, importance: number) => {
    const cleaned = sanitizeSemanticFactContent(content);
    if (!cleaned || facts.some((f) => f.content === cleaned)) return;
    facts.push({ category, content: cleaned.slice(0, 400), importance });
  };

  const name =
    t.match(/(?:我叫|我是|叫我|称呼我)\s*[「"']?([\u4e00-\u9fa5A-Za-z]{1,20})/)?.[1] ??
    t.match(/名字(?:是|叫)\s*[「"']?([\u4e00-\u9fa5A-Za-z]{1,20})/)?.[1];
  if (name) push('fact', `用户姓名是${name}`, 0.85);

  const job = t.match(/(?:我是|职业是|就职于|在)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:工程师|设计师|经理|老师|医生|律师|分析师)?)/)?.[1];
  if (job && job !== name) push('fact', `用户职业/身份：${job}`, 0.75);

  const pref = t.match(/(?:偏好|习惯|请|以后请|记住)\s*([^。！？\n]{4,80})/)?.[1];
  if (pref) push('preference', `用户偏好：${pref.trim()}`, 0.7);

  const callMe = t.match(/(?:叫我|称呼我为|请叫我)\s*[「"']?([\u4e00-\u9fa5A-Za-z]{1,16})/)?.[1];
  if (callMe) push('preference', `用户希望被称呼为${callMe}`, 0.8);

  if (facts.length === 0 && SEMANTIC_SIGNAL_RE.test(t) && t.length >= 8 && t.length <= 200) {
    push('fact', `用户提到：${t.slice(0, 160)}`, 0.55);
  }
  return facts.slice(0, 5);
}

export const DIALOGUE_EXTRACT_SYSTEM = `你是用户记忆抽取助手。只从本轮对话中提炼「可跨会话复用」的用户侧信息。
输出严格 JSON，不要 markdown 包裹。
维度：preference / fact / entity / concept。
不编造；无合格条目返回 {"facts":[]}；禁止密钥与测试噪声。
本次任务的临时要求不得保存。用户明确纠正旧事实时，content 用「更正：」开头，完整写出纠正后的事实。`;

export function buildDialogueExtractUserPrompt(params: { userText: string; assistantText?: string }): string {
  const assistant = (params.assistantText || '').trim();
  return [
    '用户本轮：',
    params.userText.slice(0, 1200),
    assistant ? `\n助手本轮（仅作语境）：\n${assistant.slice(0, 800)}` : '',
    '\n请输出 JSON：{ "facts": [ { "category": "...", "content": "...", "importance": 0.7 } ] }'
  ].join('\n');
}

export async function extractDialogueFacts(params: {
  userText: string;
  assistantText?: string;
  completeText?: (input: { system: string; user: string }) => Promise<string>;
}): Promise<DialogueExtractFact[]> {
  if (!shouldAttemptDialogueExtract(params.userText)) return [];
  if (params.completeText) {
    try {
      const text = await params.completeText({
        system: DIALOGUE_EXTRACT_SYSTEM,
        user: buildDialogueExtractUserPrompt(params)
      });
      const parsed = parseDialogueExtractJson(text || '');
      if (parsed.facts.length > 0) return parsed.facts;
    } catch {
      /* fail-soft → heuristic */
    }
  }
  return heuristicExtractDialogueFacts(params.userText);
}
