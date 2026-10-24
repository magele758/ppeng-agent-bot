import { GOAL_JUDGE_TIMEOUT_MS } from './judge-budget.js';
import { visibleTaskText } from '../fork-inheritance.js';

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
const courtesyRequest = /^(?:(?:可以|能不能|能否|可不可以)(?:请|帮我|麻烦)|(?:can|could|would|will)\s+you\b)/i;
const workRequest = /(?:请|帮我|麻烦)[\s\S]{0,24}(?:修复|实现|修改|添加|开发|部署|编写|研究|调查)|^(?:修复|实现|修改|添加|开发|部署|编写)|^(?:(?:please|can you|could you|would you|will you)\s+)?(?:fix|implement|build|deploy|write|investigate|research)\b/i;
function requestsWork(text: string): boolean {
  if (/^(?:部署|开发|修复|实现)?(?:进度|状态)|^(?:deploy(?:ment)?|build|fix)\s+(?:status|progress)\b/i.test(text)) return false;
  return workRequest.test(text) || courtesyRequest.test(text);
}
const informationalQuestion = /^(?:为什么|什么是|请解释|解释一下|如何|怎么|what is\b|why\b|how\b|explain\b)/i;
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
    && !requestsWork(text)) return { kind: 'query', ...base };
  const workVerb = text.search(/修复|修改|实现|开发|添加|分析|研究|检查|调查|说明|编写|设计|\b(?:fix|modify|add|build|implement|analy[sz]e|investigate)\b/i);
  const controlVerb = text.search(controlQuestion);
  if (isControlDiscussion(text) && !(requestsWork(text) && workVerb >= 0 && controlVerb > workVerb)) return { kind: 'chat', ...base };
  if (workVerb >= 0 && controlVerb > workVerb) return { kind: target ? 'amend_goal' : 'new_goal', ...base };
  if (/(取消|不用做了|别做了)/.test(text) && !/(取消按钮|取消功能)/.test(text)
    || /^(?:please\s+)?cancel\b/i.test(text)) return { kind: 'cancel', ...base };
  if (/(暂停|先停|停一下)/.test(text) && !/(暂停按钮|暂停功能)/.test(text)
    || /^(?:please\s+)?pause\b/i.test(text)) return { kind: 'pause', ...base };
  if (/^(继续|恢复|(?:please\s+)?resume\b)/i.test(text)) return { kind: 'resume', ...base };
  if (target || /(刚才|那个|这项|原来).*(不要|别|改|增加|保持)|别改|不要改|追加约束|\b(instead|keep unchanged|don't change|do not change)\b/i.test(text)) {
    return { kind: 'amend_goal', ...base };
  }
  if (requestsWork(text)) return { kind: 'new_goal', ...base };
  if (/^(为什么|什么是|请解释|解释一下|what is|why\b|explain\b)/i.test(text) || /[?？]$/.test(text)) return { kind: 'chat', ...base };
  if (isCoordinationInstruction(text)) return { kind: 'chat', ...base };
  return { kind: 'new_goal', ...base };
}
function isCoordinationInstruction(text: string): boolean {
  if (/(?:创建|写入|修复|实现|修改|添加|开发|部署|编写)/.test(text)) return false;
  return /(?:并行推进|不要把[\s\S]{0,16}收成一个目标|各自保留真实文件)/.test(text)
    || /^(?:请)?同时完成[\s\S]{0,16}独立的事[。.!！]?$/.test(text.trim());
}

function independentClause(text:string,piece:string):boolean {
  return /(?:独立的事|独立任务|independent tasks)/i.test(text)
    && !/^(?:然后|再|必须|不要|then\b|verify\b|do not\b)/i.test(piece.trim());
}
function fallbackClauses(text:string):string[] {
  const pieces = text.split(/(?:[；;\n]+|[，,]\s*(?=另外|顺便|然后|先|再|暂停|取消|恢复|继续)|\s+and\s+(?=then\b|pause\b|cancel\b|resume\b|also\b))/i).filter(Boolean);
  const clauses: string[] = [];
  for (const piece of pieces) {
    const previous = clauses.at(-1);
    const separate = independentClause(text,piece) || /^(?:另外|顺便|also\b)/i.test(piece.trim())
      || ['pause', 'cancel', 'resume', 'query'].includes(classifyGoalMessage(piece).kind)
      || (previous && ['pause', 'cancel', 'resume', 'query'].includes(classifyGoalMessage(previous).kind));
    if (!previous || separate) clauses.push(piece);
    else {
      const start = text.indexOf(previous);
      clauses[clauses.length - 1] = text.slice(start, text.indexOf(piece, start + previous.length) + piece.length);
    }
  }
  return clauses;
}

function explicitGoalAmend(raw: string, goals: GoalIntakeContext[]): GoalIntentProposal | undefined {
  const named = goals.filter(goal => raw.includes(goal.id));
  if (named.length !== 1) return undefined;
  if (!/(追加要求|补充要求|补充约束|必须额外|不要重做)/.test(raw)) return undefined;
  return { kind: 'amend_goal', goalId: named[0]!.id, text: raw.trim() };
}
function fallbackIntents(raw: string, goals: GoalIntakeContext[]): GoalIntentProposal[] {
  const namedAmend = explicitGoalAmend(raw, goals);
  if (namedAmend) return [namedAmend];
  const explicit = raw.match(targetPattern);
  const text = (explicit ? raw.slice(explicit[0].length) : raw).trim();
  const clauses = fallbackClauses(text);
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

const JUDGE_KINDS = new Set(['new_goal', 'amend_goal', 'query', 'pause', 'resume', 'cancel', 'reprioritize', 'chat']);
const JUDGE_INSTRUCTIONS = 'Return JSON {intents:[{kind,goalId?,text,priority?}]}. kinds: new_goal, amend_goal, query, pause, resume, cancel, reprioritize, chat. Split only independent deliverables or explicit controls; keep sequential steps, verification and constraints together with their antecedents. Preserve the full deliverable of combined investigate-and-fix requests. Polite requests and question marks do not make actionable work a chat; text must be an exact nonempty excerpt of the message. Queries and discussion of controls are never control requests. Preserve explicit [goal:id] targeting. Use only supplied goal IDs; omit goalId when ambiguous. Do not infer cancellation or completion. priority must be an integer for reprioritize.';

function judgeSkipped(judge: GoalIntentJudge | undefined, raw: string, fallback: GoalIntentProposal[]): boolean {
  return !judge || raw.length > 12000 || fallback.every(intent => intent.kind === 'query' || (intent.kind === 'chat' && (!/[?？]/.test(intent.text) || isControlDiscussion(intent.text) || informationalQuestion.test(intent.text))));
}
function outputTooLarge(output: unknown): boolean {
  return typeof output === 'string' && output.length > 16000;
}
function parsedJudge(output: unknown): { intents?: unknown[] } {
  if (typeof output !== 'string') return output as { intents?: unknown[] };
  return JSON.parse(output) as { intents?: unknown[] };
}
function usableIntents(decoded: { intents?: unknown[] } | null | undefined): unknown[] | undefined {
  if (!decoded || !Array.isArray(decoded.intents)) return undefined;
  if (!decoded.intents.length || decoded.intents.length > 8) return undefined;
  return decoded.intents;
}
function intentTextOk(item: { kind?: string; text?: unknown } | null, raw: string): boolean {
  return !!item && JUDGE_KINDS.has(String(item.kind)) && typeof item.text === 'string' && !!item.text.trim() && raw.includes(item.text);
}
function intentGoalOk(item: { goalId?: unknown }, goals: GoalIntakeContext[]): boolean {
  if (item.goalId === undefined) return true;
  return typeof item.goalId === 'string' && goals.some(goal => goal.id === item.goalId);
}
function intentKindOk(item: { kind: string }, baseline: GoalMessageIntent): boolean {
  if (baseline.kind === 'query' && item.kind !== 'query') return false;
  if (baseline.kind === 'chat' && item.kind !== 'chat' && (isControlDiscussion(baseline.text) || informationalQuestion.test(baseline.text) || !/[?？]/.test(baseline.text) || !['new_goal', 'amend_goal'].includes(item.kind))) return false;
  return !['pause', 'cancel', 'resume'].includes(item.kind) || baseline.kind === item.kind;
}
function priorityOk(item: { kind: string; priority?: number }): boolean {
  if (item.kind !== 'reprioritize') return true;
  return Number.isSafeInteger(item.priority) && Math.abs(item.priority!) <= 100;
}
function proposalFrom(item: { kind: GoalIntentProposal['kind']; text: string; goalId?: string; priority?: number }): GoalIntentProposal {
  return { kind: item.kind, text: item.text, ...(item.goalId ? { goalId: item.goalId } : {}), ...(item.kind === 'reprioritize' ? { priority: item.priority! } : {}) } as GoalIntentProposal;
}
function confirmedProposal(item: { kind: string; text: string; goalId?: string; priority?: number }, explicit: string | undefined): GoalIntentProposal | undefined {
  const baseline = classifyGoalMessage(item.text);
  if (explicit && item.goalId !== explicit) return undefined;
  if (!intentKindOk(item, baseline) || !priorityOk(item)) return undefined;
  return proposalFrom(item as { kind: GoalIntentProposal['kind']; text: string; goalId?: string; priority?: number });
}
function judgeProposal(item: { kind?: string; text?: string; goalId?: string; priority?: number } | null, raw: string, goals: GoalIntakeContext[], explicit: string | undefined): GoalIntentProposal | undefined {
  if (!item || !intentTextOk(item, raw) || !intentGoalOk(item, goals)) return undefined;
  return confirmedProposal(item as { kind: string; text: string; goalId?: string; priority?: number }, explicit);
}
function collectJudgeProposals(intents: unknown[], raw: string, goals: GoalIntakeContext[]): GoalIntentProposal[] | undefined {
  const explicit = raw.match(targetPattern)?.[1];
  const proposals: GoalIntentProposal[] = [];
  for (const item of intents) {
    const proposal = judgeProposal(item as { kind?: string; text?: string; goalId?: string; priority?: number } | null, raw, goals, explicit);
    if (!proposal) return undefined;
    proposals.push(proposal);
  }
  return proposals;
}
function keepsFallbackClauses(fallback: GoalIntentProposal[], proposals: GoalIntentProposal[]): boolean {
  if (fallback.length <= 1 && fallback[0]?.kind !== 'new_goal') return true;
  return !fallback.some(intent => !proposals.some(proposal => proposal.text.includes(intent.text)));
}
function proposalsForOutput(raw: string, goals: GoalIntakeContext[], fallback: GoalIntentProposal[], output: unknown): GoalIntentProposal[] | undefined {
  if (outputTooLarge(output)) return undefined;
  const intents = usableIntents(parsedJudge(output));
  if (!intents) return undefined;
  const proposals = collectJudgeProposals(intents, raw, goals);
  if (!proposals || !keepsFallbackClauses(fallback, proposals)) return undefined;
  return proposals;
}
function raceGoalJudge(raw: string, goals: GoalIntakeContext[], judge: GoalIntentJudge, controller: AbortController, remember: (timer: ReturnType<typeof setTimeout>) => void): Promise<unknown> {
  return Promise.race([
    judge({ text: raw, goals: goals.slice(0, 50).map(goal => ({ ...goal, title: goal.title.slice(0, 300) })), signal: controller.signal, instructions: JUDGE_INSTRUCTIONS }),
    new Promise<never>((_, reject) => { remember(setTimeout(() => { controller.abort(); reject(new Error('Goal intent judge timed out')); }, GOAL_JUDGE_TIMEOUT_MS)); })
  ]);
}
async function judgedIntents(raw: string, goals: GoalIntakeContext[], fallback: GoalIntentProposal[], judge: GoalIntentJudge): Promise<GoalIntentProposal[] | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await raceGoalJudge(raw, goals, judge, controller, timer => { timeout = timer; });
    return proposalsForOutput(raw, goals, fallback, output);
  } catch { return undefined; }
  finally { if (timeout) clearTimeout(timeout); }
}

const recallInquiry = /复述|还记得|记不记得|记得不|记得吗|do you still remember|\brecite\b/i;
const exploreInquiry = /看看[\s\S]{0,40}(?:有什么|哪些)[\s\S]{0,24}(?:可以|能)(?:搬|借鉴|复用|迁移|参考)|有什么可以(?:搬|借鉴|复用|迁移)|see what[\s\S]{0,60}could be ported/i;
const consultInquiry = /商量一下|商量商量|讨论一下|你觉得|你怎么看|要不要先|是否应该|是不是该|你先说说|先确认一下|我先看看你|let's discuss|what do you think/i;

function hasStatedOutcome(text: string): boolean {
  return /完成结果(?:是|为)|验收(?:标准|条件)是|(?:交付物|结果)是/.test(text);
}
function hasImperativeWork(text: string): boolean {
  const stripped = text.replace(/开发规则|开发规范|开发约定/g, '');
  return /(?:请|帮我|麻烦)[\s\S]{0,16}(?:分析|实现|添加|修复|编写|设计|检查|调查|改成|做完|搬到|迁移到|开发)/.test(stripped)
    || /^(?:请|帮我|麻烦)?\s*(?:分析|实现|添加|修复|编写|设计|检查|调查|改成|做完|搬到|迁移到|开发)/.test(stripped);
}
const deliveryWork = /完成结果(?:是|为)|验收(?:标准|条件)|交付物|(?:修复|修改|改成|实现|添加|开发|编写|部署|迁移|重构|写好|做完|提交|发布)|\b(?:fix|implement|build|deploy|migrate|refactor)\b/i;
const isolatedHandoff = /拆成子任务|拆成并行|并行处理|分别交给|交给(?:规划|实现|验收|评估)|子代理/;
const selfContainedWork = /分析|说明|解释|看看|看下|检查|查看|总结|梳理|对比|\b(?:analy[sz]e|explain|inspect|summarize)\b/i;

/** Returning an existing deployment result is not a request to deploy again. */
function isHistoricalResultQuery(text: string): boolean {
  const result = text.match(/^(?:根据|基于)(?:已经|之前|此前|已有|现有|先前)[^，,。；;\n]*(?:检查|结果|日志|证据|报告)[，,]\s*((?:返回|告知|告诉我|给出)[\s\S]+)$/)
    ?? text.match(/^(?:based on|from)\s+(?:the\s+)?(?:existing|previous|earlier|already)[^,;\n]+[,;]\s*((?:return|report|tell me|give me)\b[\s\S]+)$/i);
  if (!result?.[1]) return false;
  const request = result[1]
    .replace(/(?:部署|发布|构建)(?:版本|状态|结果|日志|报告)/g, '历史结果')
    .replace(/\b(?:deployment|deployed|build|release)\s+(?:version|status|result|report|log)\b/gi, 'historical result');
  return !deliveryWork.test(request)
    && !/保存|写入|删除|更新|升级|执行|运行|重启|发起|启动|创建|触发|回滚|安装|发送|重试|\b(?:publish|upgrade|update|save|write|delete|remove|run|execute|restart|start|create|trigger|rollback|roll back|install|send|retry|change)\b/i.test(request);
}

/** Analysis, explanation, or inspection the current Bot can finish in this chat. A stated delivery still stays a goal. */
export function isSelfContainedBotWork(text: string): boolean {
  if (hasStatedOutcome(text) || isolatedHandoff.test(text)) return false;
  if (isHistoricalResultQuery(text)) return true;
  if (deliveryWork.test(text)) return false;
  if (/设计方案|制定[\s\S]{0,12}规划|开发功能/.test(text)) return false;
  return selfContainedWork.test(text);
}
/** Asking, discussing, or checking memory without a stated deliverable. Shared room classification stays unchanged. */
export function isUndirectedInquiry(text: string): boolean {
  if (hasStatedOutcome(text) || hasImperativeWork(text)) return false;
  return recallInquiry.test(text) || exploreInquiry.test(text) || consultInquiry.test(text);
}
export function releaseOpenInquiry(intent: GoalIntentProposal): GoalIntentProposal {
  if (intent.kind === 'query' || intent.kind === 'chat' || intent.kind === 'pause' || intent.kind === 'resume' || intent.kind === 'cancel') return intent;
  return isUndirectedInquiry(intent.text) ? { kind: 'chat', text: intent.text } : intent;
}
/** Bot chat only. A new goal the current Bot can finish itself stays a chat turn. Room intake does not use this. */
export function releaseSelfContainedBotWork(intent: GoalIntentProposal): GoalIntentProposal {
  if (intent.kind !== 'new_goal') return intent;
  return isSelfContainedBotWork(intent.text) ? { kind: 'chat', text: intent.text } : intent;
}

/** Judge proposals are untrusted. Callers still validate scoped target ownership and goal revision. */
export async function classifyGoalIntents(raw: string, goals: GoalIntakeContext[], judge?: GoalIntentJudge): Promise<GoalIntentProposal[]> {
  const text = visibleTaskText(raw);
  const fallback = fallbackIntents(text, goals);
  if (judgeSkipped(judge, text, fallback)) return fallback;
  const judged = await judgedIntents(text, goals, fallback, judge!);
  return judged ?? fallback;
}
