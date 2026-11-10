import type { BotGoal } from './types.js';

/** What a short follow-up asks of the unfinished goal in the chat. */
export type FollowupKind = 'continue' | 'progress' | 'about_goal';

/** `attach`: this turn works on the goal. `status`: the goal runs elsewhere, only report it. */
export type FollowupAction = 'attach' | 'status';

export interface FollowupPlan {
  kind: FollowupKind;
  goalId: string;
  action: FollowupAction;
  /** Why this action, in a word. Recorded with the intake trace. */
  reason: string;
}

const CONTINUE_NUDGE = /^(?:好的?|行|可以|嗯+|对|ok(?:ay)?|yes|那就?|请|麻烦|你|then|please)?[\s,，。.!！]*(?:继续(?:吧|做|干|搞|弄|跑|推进|执行|下去|完成|处理)?|接着(?:做|干|来|搞|弄|跑|推进)?|往下(?:做|走|推进)|别停|不要停|做完(?:它|吧)?|go on|go ahead|continue|keep going|carry on|proceed|keep at it)[\s,，。.!！~吧啊呀哈]*$/i;
const PROGRESS_QUERY = /^(?:现在|目前|那个?|这个|任务|事情|你|到底|请问|所以|嗯|喂|hi|hey|so|[\s,，])*(?:什么进度|进度(?:如何|怎么样|咋样)?|进展(?:如何|怎么样|咋样)?|到哪(?:一步)?了?|做到哪了?|怎么样了|咋样了|如何了|(?:跑|做|干|搞|弄|写|改|修|部署|测|完成)(?:完|好)了?(?:吗|没有?|么)?|(?:好|完成|结束|搞定)了(?:吗|没有?|么)?|还没(?:好|完|跑完|做完|干完)|还在跑|有结果了?(?:吗|没有?)?|any (?:updates?|progress|news)|how(?:'s| is) it going|status|progress|is it (?:done|finished)(?: yet)?|done yet|are you done)[\s?？!！。.~呢啊吧了吗]*$/i;
const REFERENCE_CUE = /刚才|之前|上面|那个|这个任务|该任务|那件事|上次|\b(?:the task|that task|earlier|previous(?:ly)?)\b/i;
const OUTCOME_CUE = /结果|怎么样|如何了|好了|完成|成功|失败|报错|卡住|还在|为什么停|\b(?:done|finished|results?|fail(?:ed)?|stuck|stopped)\b/i;

/** A bare push to keep going. Questions about continuing are not a push. */
export function isContinueNudge(text: string): boolean {
  const clean = text.trim();
  return clean.length > 0 && clean.length <= 24 && !/[?？吗么]/.test(clean) && CONTINUE_NUDGE.test(clean);
}

/** A short question about how far the work got. */
export function isProgressQuery(text: string): boolean {
  const clean = text.trim();
  return clean.length > 0 && clean.length <= 30 && PROGRESS_QUERY.test(clean);
}

/** A short question that points back at earlier work and asks how it turned out. Needs a judge to confirm. */
export function mayConcernGoal(text: string): boolean {
  const clean = text.trim();
  return clean.length > 0 && clean.length <= 80 && REFERENCE_CUE.test(clean) && OUTCOME_CUE.test(clean);
}

/** Deterministic kinds only. `about_goal` is decided by the caller with a judge. */
export function followupKind(text: string): 'continue' | 'progress' | undefined {
  if (isContinueNudge(text)) return 'continue';
  if (isProgressQuery(text)) return 'progress';
  return undefined;
}

const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

export function isOpenGoal(goal: BotGoal): boolean {
  return !TERMINAL.has(goal.status);
}

/** The unfinished goal the chat touched last, if that was recent enough. */
export function recentOpenGoal(goals: BotGoal[], now: number, windowMs: number): BotGoal | undefined {
  const open = goals.filter(isOpenGoal).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = open[0];
  if (!latest) return undefined;
  return now - Date.parse(latest.updatedAt) <= windowMs ? latest : undefined;
}

function busyElsewhere(goal: BotGoal): boolean {
  return Boolean(goal.activeExecutionId || goal.draining || goal.wait) || goal.status === 'running' || goal.status === 'waiting';
}

/**
 * Decide what a follow-up does to the goal. A goal that is executing or waiting
 * is never started twice. A paused goal resumes only on an explicit push.
 */
export function planFollowup(kind: FollowupKind, goal: BotGoal): FollowupPlan {
  const base = { kind, goalId: goal.id };
  if (busyElsewhere(goal)) return { ...base, action: 'status', reason: `goal_${goal.status}` };
  if (goal.status === 'paused' && kind !== 'continue') return { ...base, action: 'status', reason: 'goal_paused' };
  return { ...base, action: 'attach', reason: `goal_${goal.status}` };
}

export const FOLLOWUP_JUDGE_PROMPT = 'Decide whether the user message is a follow-up about the unfinished goal given below, such as asking how it went or asking to finish it. Unrelated questions, new requests and small talk are not follow-ups. When unsure, answer false. Return JSON {"related":true|false,"reason":"short"}.';

export function parseFollowupVerdict(output: unknown): boolean {
  const decoded = typeof output === 'string' ? JSON.parse(output) : output;
  const related = (decoded as { related?: unknown } | null)?.related;
  if (typeof related !== 'boolean') throw new Error('Invalid follow-up verdict');
  return related;
}

export function followupInstruction(kind: FollowupKind, goal: BotGoal): string {
  const title = goal.title.slice(0, 120);
  if (kind === 'continue') {
    return `[goal follow-up] The user asked to continue the unfinished goal "${title}". Do the remaining work now in this turn. Do not ask which goal is meant.`;
  }
  return `[goal follow-up] The user asked about the unfinished goal "${title}". Tell them where it stands in a few lines, then keep working on what remains in this turn.`;
}

export const CONTINUE_UNBOUND_INSTRUCTION = '[follow-up] The user asked to continue. Pick up the unfinished work from this conversation and do it now. Do not ask which task is meant; if nothing is left to do, say so in one line.';
