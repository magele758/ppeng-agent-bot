/** Pure helpers for tool-result fold UI (CRAP-coverable without JSX transpile). */

export function toolResultFoldClass(flags: {
  ok: boolean;
  modelView?: boolean;
  stub: boolean;
  isSubagent: boolean;
  isSteerSkipped: boolean;
  spawnBlocked: boolean;
}): string {
  const parts = [
    'chat-tool-fold chat-tool-fold--result chat-tool-fold--compact',
    flags.ok ? 'chat-tool-fold--success' : 'chat-tool-fold--error'
  ];
  if (flags.modelView) parts.push('chat-tool-fold--model-view');
  if (flags.stub) parts.push('chat-tool-fold--stub');
  if (flags.isSubagent) parts.push('chat-tool-fold--subagent');
  if (flags.isSteerSkipped) parts.push('chat-tool-fold--steer');
  if (flags.spawnBlocked) parts.push('chat-tool-fold--blocked');
  return parts.join(' ');
}

export type ToolResultStatusKind = 'steer' | 'blocked' | 'subagent' | 'teammate' | 'ok' | 'err';

export function toolResultStatusKind(flags: {
  isSteerSkipped: boolean;
  spawnBlocked: boolean;
  isSubagent: boolean;
  isTeammate: boolean;
  ok: boolean;
}): ToolResultStatusKind {
  if (flags.isSteerSkipped) return 'steer';
  if (flags.spawnBlocked) return 'blocked';
  if (flags.isSubagent) return 'subagent';
  if (flags.isTeammate) return 'teammate';
  return flags.ok ? 'ok' : 'err';
}

/** Pill render spec for status; null means hide (blocked). */
export type ToolResultStatusPillSpec = {
  className: string;
  i18nKey: 'play.turns.steerSkip' | 'play.turns.subagentDeliver' | 'play.turns.teammateReply' | 'play.output' | 'play.fail';
};

export function toolResultStatusPillSpec(kind: ToolResultStatusKind): ToolResultStatusPillSpec | null {
  switch (kind) {
    case 'blocked':
      return null;
    case 'steer':
      return { className: 'chat-tool-fold__pill chat-tool-fold__pill--steer', i18nKey: 'play.turns.steerSkip' };
    case 'subagent':
      return { className: 'chat-tool-fold__pill chat-tool-fold__pill--subagent', i18nKey: 'play.turns.subagentDeliver' };
    case 'teammate':
      return { className: 'chat-tool-fold__pill chat-tool-fold__pill--team', i18nKey: 'play.turns.teammateReply' };
    case 'ok':
      return { className: 'chat-tool-fold__pill chat-tool-fold__pill--ok', i18nKey: 'play.output' };
    case 'err':
      return { className: 'chat-tool-fold__pill chat-tool-fold__pill--err', i18nKey: 'play.fail' };
  }
}

export function toolResultBodyMode(flags: {
  isSubagent: boolean;
  stub: boolean;
  modelView?: boolean;
  spawnBlocked: boolean;
}): 'markdown' | 'io' {
  return flags.isSubagent && !flags.stub && !flags.modelView && !flags.spawnBlocked ? 'markdown' : 'io';
}

export type ToolResultSummaryFlag =
  | 'confidence-low'
  | 'confidence-ok'
  | 'model-view'
  | 'spawn-blocked'
  | 'sandbox'
  | 'stub'
  | 'trimmed';

export function toolResultSummaryFlags(input: {
  confidence: string | null;
  isLowConf: boolean;
  modelView?: boolean;
  spawnBlocked: boolean;
  sandboxReason: unknown;
  stub: boolean;
  trimmed: boolean;
}): ToolResultSummaryFlag[] {
  const out: ToolResultSummaryFlag[] = [];
  if (input.confidence) out.push(input.isLowConf ? 'confidence-low' : 'confidence-ok');
  if (input.modelView) out.push('model-view');
  if (input.spawnBlocked) out.push('spawn-blocked');
  if (input.sandboxReason) out.push('sandbox');
  if (input.stub) out.push('stub');
  if (input.trimmed) out.push('trimmed');
  return out;
}

/** Declarative summary pills so ChatTurns ToolResultSummary stays a thin mapper. */
export type ToolResultSummaryPillSpec =
  | {
      id: 'confidence';
      className: string;
      i18nKey: 'play.turns.confidence';
      value: string;
    }
  | { id: 'model-view'; className: string; i18nKey: 'play.modelViewOnly' }
  | { id: 'spawn-blocked' }
  | {
      id: 'sandbox';
      className: string;
      i18nKey: string;
      testId: 'os-sandbox-reason';
    }
  | { id: 'stub'; className: string; i18nKey: 'play.stub' }
  | { id: 'trimmed'; className: string; i18nKey: 'play.trimmed' };

export function toolResultSummaryPillSpecs(input: {
  confidence: string | null;
  isLowConf: boolean;
  modelView?: boolean;
  spawnBlocked: boolean;
  sandboxReasonKey: string | null | undefined;
  stub: boolean;
  trimmed: boolean;
}): ToolResultSummaryPillSpec[] {
  const flags = toolResultSummaryFlags({
    confidence: input.confidence,
    isLowConf: input.isLowConf,
    modelView: input.modelView,
    spawnBlocked: input.spawnBlocked,
    sandboxReason: input.sandboxReasonKey,
    stub: input.stub,
    trimmed: input.trimmed
  });
  const pills: ToolResultSummaryPillSpec[] = [];
  for (const flag of flags) {
    if (flag === 'confidence-low' || flag === 'confidence-ok') {
      pills.push({
        id: 'confidence',
        className: `chat-tool-fold__pill ${flag === 'confidence-low' ? 'chat-tool-fold__pill--err' : 'chat-tool-fold__pill--ok'}`,
        i18nKey: 'play.turns.confidence',
        value: input.confidence ?? ''
      });
      continue;
    }
    if (flag === 'model-view') {
      pills.push({
        id: 'model-view',
        className: 'chat-tool-fold__pill chat-tool-fold__pill--model-view',
        i18nKey: 'play.modelViewOnly'
      });
      continue;
    }
    if (flag === 'spawn-blocked') {
      pills.push({ id: 'spawn-blocked' });
      continue;
    }
    if (flag === 'sandbox') {
      pills.push({
        id: 'sandbox',
        className: 'chat-tool-fold__pill',
        i18nKey: input.sandboxReasonKey ?? '',
        testId: 'os-sandbox-reason'
      });
      continue;
    }
    if (flag === 'stub') {
      pills.push({ id: 'stub', className: 'chat-tool-fold__pill chat-tool-fold__pill--stub', i18nKey: 'play.stub' });
      continue;
    }
    pills.push({ id: 'trimmed', className: 'chat-tool-fold__pill chat-tool-fold__pill--trim', i18nKey: 'play.trimmed' });
  }
  return pills;
}

/** How a summary pill paints. spawn-blocked stays a dedicated component. */
export type ToolResultSummaryPillPaint =
  | { paint: 'spawn-blocked' }
  | { paint: 'span'; className: string; textKey: string; textParams?: Record<string, string>; testId?: string };

function pillTextParams(pill: Exclude<ToolResultSummaryPillSpec, { id: 'spawn-blocked' }>): Record<string, string> | undefined {
  return pill.id === 'confidence' ? { value: pill.value } : undefined;
}

function pillTestId(pill: Exclude<ToolResultSummaryPillSpec, { id: 'spawn-blocked' }>): string | undefined {
  return pill.id === 'sandbox' ? pill.testId : undefined;
}

/** Data-driven paint spec so the React pill view has no id chain. */
export function toolResultSummaryPillPaint(pill: ToolResultSummaryPillSpec): ToolResultSummaryPillPaint {
  if (pill.id === 'spawn-blocked') return { paint: 'spawn-blocked' };
  return {
    paint: 'span',
    className: pill.className,
    textKey: pill.i18nKey,
    textParams: pillTextParams(pill),
    testId: pillTestId(pill)
  };
}
