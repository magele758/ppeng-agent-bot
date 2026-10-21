export interface GoalMessageIntent {
  kind: 'new_goal' | 'amend_goal' | 'query' | 'pause' | 'resume' | 'cancel' | 'chat';
  goalId?: string;
  text: string;
}
export type GoalIntentProposal = GoalMessageIntent | { kind: 'reprioritize'; goalId?: string; text: string; priority: number };
export interface GoalIntakeContext { id: string; title: string; status: string; priority?: number }
export interface GoalIntentJudgeInput {
  text: string;
  goals: GoalIntakeContext[];
  instructions: string;
  signal: AbortSignal;
}
export type GoalIntentJudge = (input: GoalIntentJudgeInput) => Promise<unknown>;

const targetPattern = /^\s*\[goal:([^\]\s]+)\]\s*/;
const controlQuestion = /(?:取消|暂停|停止|继续|恢复|cancel|pause|stop|resume)/i;
function isControlDiscussion(text: string): boolean {
  return controlQuestion.test(text) && (/[?？吗么]/.test(text)
    || /^(?:为什么|如何|怎么|解释|请解释|能否|是否|can\b|could\b|would\b|should\b|how\b|why\b|what\b|explain\b)/i.test(text)
    || /(?:不要|别|不能|无需|不必)\s*(?:取消|暂停|停止)|\b(?:don't|do not|never)\s+(?:cancel|pause|stop)/i.test(text));
}
/** Explicit targeting wins; unresolved references are left for the service to clarify. */
export function classifyGoalMessage(raw: string): GoalMessageIntent {
  const target = raw.match(targetPattern);
  const text = (target ? raw.slice(target[0].length) : raw).trim();
  const base = { ...(target ? { goalId: target[1]! } : {}), text };
  if (!text || /^(谢谢|多谢|好的|收到|你好|thanks?|thank you|hello|hi)[！!。.\s]*$/i.test(text)) return { kind: 'chat', ...base };
  if (/(进度|进展|做到哪|怎么样了|状态如何|完成了吗|完成了没|跑完了没|还没好|status|progress|how.*going)/i.test(text)
    && !/(帮我.*(实现|开发)|implement|build)/i.test(text)) return { kind: 'query', ...base };
  if (isControlDiscussion(text)) return { kind: 'chat', ...base };
  const workVerb = text.search(/实现|开发|添加|分析|研究|检查|调查|说明|编写|设计|\b(?:add|build|implement|analy[sz]e|investigate)\b/i);
  const controlVerb = text.search(controlQuestion);
  if (workVerb >= 0 && controlVerb > workVerb) return { kind: target ? 'amend_goal' : 'new_goal', ...base };
  if (/(取消|不用做了|别做了)/.test(text) && !/(取消按钮|取消功能)/.test(text)
    || /^(?:please\s+)?cancel\b/i.test(text)) return { kind: 'cancel', ...base };
  if (/(暂停|先停|停一下)/.test(text) && !/(暂停按钮|暂停功能)/.test(text)
    || /^(?:please\s+)?pause\b/i.test(text)) return { kind: 'pause', ...base };
  if (/^(继续|恢复|(?:please\s+)?resume\b)/i.test(text)) return { kind: 'resume', ...base };
  if (target || /(刚才|那个|这项|原来).*(不要|别|改|增加|保持)|别改|不要改|追加约束|\b(instead|keep unchanged|don't change|do not change)\b/i.test(text)) {
    return { kind: 'amend_goal', ...base };
  }
  if (/^(为什么|什么是|请解释|解释一下|what is|why\b|explain\b)/i.test(text) || /[?？]$/.test(text)) return { kind: 'chat', ...base };
  return { kind: 'new_goal', ...base };
}

function fallbackIntents(raw: string, goals: GoalIntakeContext[]): GoalIntentProposal[] {
  const explicit = raw.match(targetPattern);
  const text = (explicit ? raw.slice(explicit[0].length) : raw).trim();
  const clauses = text.split(/(?:[；;\n]+|[，,]\s*(?=另外|顺便|然后|先|再|暂停|取消|恢复|继续)|\s+and\s+(?=then\b|pause\b|cancel\b|resume\b|also\b))/i).filter(Boolean);
  // Overly complex messages stay intact for semantic interpretation instead of losing clauses.
  if (clauses.length > 8) return [classifyGoalMessage(raw)];
  return (clauses.length ? clauses : ['']).map(clause => {
    const clean = clause.replace(/^(?:另外|顺便|然后|then\s+|also\s+)\s*/i, '').trim();
    const parsed = classifyGoalMessage(`${explicit?.[0] ?? ''}${clean}`);
    const matches = goals.filter(goal => goal.title.trim().length >= 2 && clean.toLowerCase().includes(goal.title.trim().toLowerCase()));
    const named = explicit?.[1] ?? (matches.length === 1 ? matches[0]!.id : undefined);
    if (!isControlDiscussion(clean) && !/[?？吗么]/.test(clean) && /(?:提高|降低|调高|调低|提升|优先处理).*优先级|(?:提高|降低|调高|调低|提升).*优先|\b(?:raise|lower|increase|decrease)\b.*\bpriority\b/i.test(clean)) {
      const current = goals.find(goal => goal.id === named)?.priority ?? 0;
      const delta = /降低|调低|\b(?:lower|decrease)\b/i.test(clean) ? -1 : 1;
      return { kind: 'reprioritize', text: clean, ...(named ? { goalId: named } : {}), priority: current + delta };
    }
    return parsed.kind === 'new_goal' || parsed.kind === 'chat' ? parsed : { ...parsed, ...(named ? { goalId: named } : {}) };
  });
}

/** Judge proposals are untrusted. Callers still validate scoped target ownership and goal revision. */
export async function classifyGoalIntents(raw: string, goals: GoalIntakeContext[], judge?: GoalIntentJudge): Promise<GoalIntentProposal[]> {
  const fallback = fallbackIntents(raw, goals);
  if (!judge || raw.length > 12000 || fallback.every(intent => intent.kind === 'query' || intent.kind === 'chat')) return fallback;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      judge({ text: raw, goals: goals.slice(0, 50).map(goal => ({ ...goal, title: goal.title.slice(0, 300) })), signal: controller.signal,
        instructions: 'Return JSON {intents:[{kind,goalId?,text,priority?}]}. kinds: new_goal, amend_goal, query, pause, resume, cancel, reprioritize, chat. Split independent intents; text must be an exact nonempty excerpt of the message. Queries and discussion of controls are never control requests. Preserve explicit [goal:id] targeting. Use only supplied goal IDs; omit goalId when ambiguous. Do not infer cancellation or completion. priority must be an integer for reprioritize.' }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Goal intent judge timed out')); }, 3000); })
    ]);
    if (typeof output === 'string' && output.length > 16000) return fallback;
    const decoded = typeof output === 'string' ? JSON.parse(output) : output;
    if (!decoded || !Array.isArray(decoded.intents) || !decoded.intents.length || decoded.intents.length > 8) return fallback;
    const proposals = validateGoalProposals(raw, goals, decoded.intents);
    if (!proposals) return fallback;
    // A model must not silently drop an independently recognized query or control clause.
    if (fallback.length > 1 && fallback.some(intent => !proposals.some(proposal => proposal.text.includes(intent.text)))) return fallback;
    return proposals;
  } catch { return fallback; }
  finally { if (timeout) clearTimeout(timeout); controller.abort(); }
}

function validateGoalProposals(raw: string, goals: GoalIntakeContext[], items: Array<{kind:string;text:string;goalId?:string;priority?:number}>): GoalIntentProposal[] | undefined {
    const explicit = raw.match(targetPattern)?.[1];
    const allowed = new Set(['new_goal', 'amend_goal', 'query', 'pause', 'resume', 'cancel', 'reprioritize', 'chat']);
    const proposals: GoalIntentProposal[] = [];
    for (const item of items) {
      if (!item || !allowed.has(item.kind) || typeof item.text !== 'string' || !item.text.trim() || !raw.includes(item.text)) return undefined;
      if (item.goalId !== undefined && (typeof item.goalId !== 'string' || !goals.some(goal => goal.id === item.goalId))) return undefined;
      if (explicit && item.goalId !== explicit) return undefined;
      const baseline = classifyGoalMessage(item.text);
      if (['query', 'chat'].includes(baseline.kind) && item.kind !== baseline.kind) return undefined;
      if (['pause', 'cancel', 'resume'].includes(item.kind) && baseline.kind !== item.kind) return undefined;
      if (item.kind === 'reprioritize' && (!Number.isSafeInteger(item.priority) || Math.abs(item.priority!) > 100)) return undefined;
      proposals.push({ kind: item.kind, text: item.text, ...(item.goalId ? { goalId: item.goalId } : {}), ...(item.kind === 'reprioritize' ? { priority: item.priority } : {}) } as GoalIntentProposal);
    }
    return proposals;
}
