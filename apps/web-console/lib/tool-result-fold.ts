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
