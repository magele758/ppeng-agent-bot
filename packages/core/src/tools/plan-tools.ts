import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunContext, ToolContract } from '../types.js';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanStepState {
  title: string;
  status: PlanStepStatus;
  result?: string;
  error?: string;
}

/**
 * Plan state for plan-tools (legacy format).
 * Extended fields (replanTriggers, resumePolicy) can be added for forward-compat
 * but are optional; old plan files without them remain readable.
 */
export interface PlanState {
  analysis: string;
  steps: PlanStepState[];
  confirmed: boolean;
  /** Optional v2.3 extension: structured replan triggers. */
  replanTriggers?: Array<{
    id: string;
    condition: string;
    predicate: unknown; // Opaque; validated by kernel
    action: 'repair_plan';
  }>;
  /** Optional v2.3 extension: recovery policy per step. */
  resumePolicy?: Record<string, string>;
}

export type PlanEvent =
  | { type: 'submit'; analysis: string; steps: string[] }
  | { type: 'confirm' }
  | { type: 'start'; stepIndex: number }
  | { type: 'complete'; stepIndex: number; result?: string }
  | { type: 'fail'; stepIndex: number; error: string };

export type PlanApplyResult =
  | { ok: true; state: PlanState }
  | { ok: false; error: string; state: PlanState | null };

/** 1-based index from tools → 0-based. */
function toInternalIndex(stepIndex: number, total: number): number | undefined {
  if (!Number.isInteger(stepIndex) || stepIndex < 1 || stepIndex > total) return undefined;
  return stepIndex - 1;
}

export function applyPlanEvent(state: PlanState | null, event: PlanEvent): PlanApplyResult {
  if (event.type === 'submit') {
    const steps = event.steps.map((s) => String(s).trim()).filter(Boolean);
    if (steps.length < 2) {
      return { ok: false, error: '计划至少需要 2 个步骤', state };
    }
    if (steps.length > 10) {
      return { ok: false, error: '计划最多 10 个步骤', state };
    }
    return {
      ok: true,
      state: {
        analysis: event.analysis.trim(),
        steps: steps.map((title) => ({ title, status: 'pending' })),
        confirmed: false
      }
    };
  }

  if (!state) {
    return { ok: false, error: '尚未提交计划，请先 submit_plan', state: null };
  }

  if (event.type === 'confirm') {
    if (state.confirmed) {
      return { ok: true, state };
    }
    return { ok: true, state: { ...state, confirmed: true } };
  }

  if (!state.confirmed) {
    return { ok: false, error: '计划尚未确认，请先 request_confirmation / confirm_plan', state };
  }

  const idx = toInternalIndex(event.stepIndex, state.steps.length);
  if (idx === undefined) {
    return { ok: false, error: `无效的步骤索引: ${event.stepIndex}`, state };
  }
  const step = state.steps[idx]!;

  if (event.type === 'start') {
    if (step.status === 'completed') {
      return { ok: false, error: `步骤 ${event.stepIndex} 已完成，不能重新开始`, state };
    }
    if (step.status === 'failed') {
      return { ok: false, error: `步骤 ${event.stepIndex} 已失败，不能开始`, state };
    }
    const otherInProgress = state.steps.findIndex((s, i) => i !== idx && s.status === 'in_progress');
    if (otherInProgress >= 0) {
      return { ok: false, error: `步骤 ${otherInProgress + 1} 仍在进行中`, state };
    }
    const next = clonePlan(state);
    next.steps[idx] = { ...step, status: 'in_progress' };
    return { ok: true, state: next };
  }

  if (event.type === 'complete') {
    if (step.status !== 'in_progress') {
      return { ok: false, error: `步骤 ${event.stepIndex} 未在进行中，不能完成`, state };
    }
    const next = clonePlan(state);
    next.steps[idx] = { ...step, status: 'completed', result: event.result };
    return { ok: true, state: next };
  }

  if (event.type === 'fail') {
    if (step.status !== 'in_progress') {
      return { ok: false, error: `步骤 ${event.stepIndex} 未在进行中，不能标记失败`, state };
    }
    const next = clonePlan(state);
    next.steps[idx] = { ...step, status: 'failed', error: event.error };
    return { ok: true, state: next };
  }

  return { ok: false, error: '未知计划事件', state };
}

function clonePlan(state: PlanState): PlanState {
  return {
    analysis: state.analysis,
    confirmed: state.confirmed,
    steps: state.steps.map((s) => ({ ...s }))
  };
}

export function planStatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, 'plans', `${sessionId}.json`);
}

export async function loadPlanState(stateDir: string, sessionId: string): Promise<PlanState | null> {
  try {
    const raw = await readFile(planStatePath(stateDir, sessionId), 'utf8');
    const parsed = JSON.parse(raw) as PlanState;
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function savePlanState(stateDir: string, sessionId: string, state: PlanState): Promise<void> {
  const file = planStatePath(stateDir, sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

function formatPlan(state: PlanState): string {
  const lines = state.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`);
  return `分析：${state.analysis || '—'}\n确认：${state.confirmed ? '是' : '否'}\n${lines.join('\n')}`;
}

async function applyAndPersist(
  context: RunContext,
  event: PlanEvent
): Promise<{ ok: boolean; content: string }> {
  const current = await loadPlanState(context.stateDir, context.session.id);
  const result = applyPlanEvent(current, event);
  if (!result.ok) {
    return { ok: false, content: result.error };
  }
  await savePlanState(context.stateDir, context.session.id, result.state);
  return { ok: true, content: formatPlan(result.state) };
}

export function createPlanTools(): ToolContract<any>[] {
  const submitPlan: ToolContract<{ analysis: string; steps: string[] }> = {
    name: 'submit_plan',
    description:
      '提交本轮执行计划（至少 2 步、最多 10 步）。提交后须 request_confirmation，再 start_step / complete_step / fail_step。',
    inputSchema: {
      type: 'object',
      properties: {
        analysis: { type: 'string', description: '任务分析（目标、能力、预期结果）' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '执行步骤，至少 2 个、最多 10 个'
        }
      },
      required: ['analysis', 'steps']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      return applyAndPersist(context, {
        type: 'submit',
        analysis: String(args.analysis ?? ''),
        steps: Array.isArray(args.steps) ? args.steps.map(String) : []
      });
    }
  };

  const confirmPlan: ToolContract<{ message?: string }> = {
    name: 'request_confirmation',
    description: '确认已提交的计划并开始执行。别名：confirm_plan。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '可选确认说明' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context) {
      const result = await applyAndPersist(context, { type: 'confirm' });
      if (!result.ok) return result;
      return { ok: true, content: `${result.content}\n请 start_step({step_index: 1}) 开始第一步。` };
    }
  };

  const confirmAlias: ToolContract<{ message?: string }> = {
    ...confirmPlan,
    name: 'confirm_plan',
    description: '确认已提交的计划（与 request_confirmation 相同）。'
  };

  const startStep: ToolContract<{ step_index: number }> = {
    name: 'start_step',
    description: '开始执行计划步骤。step_index 从 1 开始。',
    inputSchema: {
      type: 'object',
      properties: { step_index: { type: 'number' } },
      required: ['step_index']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      return applyAndPersist(context, { type: 'start', stepIndex: Number(args.step_index) });
    }
  };

  const completeStep: ToolContract<{ step_index: number; result?: string }> = {
    name: 'complete_step',
    description: '标记规划步骤已完成。step_index 从 1 开始，且必须先 start_step。',
    inputSchema: {
      type: 'object',
      properties: {
        step_index: { type: 'number' },
        result: { type: 'string' }
      },
      required: ['step_index']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      return applyAndPersist(context, {
        type: 'complete',
        stepIndex: Number(args.step_index),
        result: typeof args.result === 'string' ? args.result : undefined
      });
    }
  };

  const failStep: ToolContract<{ step_index: number; error: string }> = {
    name: 'fail_step',
    description: '标记规划步骤失败。step_index 从 1 开始，且必须先 start_step。',
    inputSchema: {
      type: 'object',
      properties: {
        step_index: { type: 'number' },
        error: { type: 'string' }
      },
      required: ['step_index', 'error']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      return applyAndPersist(context, {
        type: 'fail',
        stepIndex: Number(args.step_index),
        error: String(args.error ?? 'failed')
      });
    }
  };

  return [submitPlan, confirmPlan, confirmAlias, startStep, completeStep, failStep];
}
