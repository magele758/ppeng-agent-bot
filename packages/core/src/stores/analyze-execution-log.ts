/**
 * Turn a session execution log into a problem list another agent can investigate.
 * Pure: it reads events only, never the transcript, the disk, or the environment.
 */

export type ExecutionFindingCode =
  | 'tool_failed'
  | 'tool_unpaired'
  | 'model_error'
  | 'truncated'
  | 'recovery_stop'
  | 'missing_usage'
  | 'skill_rejected'
  | 'goal_not_met'
  | 'waiting_approval'
  | 'approval_rejected';

export interface ExecutionFinding {
  code: ExecutionFindingCode;
  ts: string;
  kind: string;
  message: string;
  sessionId?: string;
  turn?: number;
  toolCallId?: string;
  name?: string;
}

export interface ExecutionLogEvent {
  ts?: string;
  sessionId?: string;
  kind: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

const RECOVERY_KINDS = new Set(['recovery_abort', 'repetition_abort', 'reasoning_spin_abort']);

const RECOVERY_REASONS = new Set([
  'empty_assistant',
  'content_filter',
  'missing_assistant',
  'repetition',
  'reasoning_spin',
  'repeat_detection',
  'tool_loop',
]);

interface OpenStart {
  ts: string;
  sessionId?: string;
  turn?: number;
  name: string;
  toolCallId?: string;
}

interface ScanState {
  findings: ExecutionFinding[];
  open: OpenStart[];
  ends: Map<string, number>;
  turn?: number;
  turnHasTruncated: boolean;
  turnHasRecovery: boolean;
  turnHasWaitingHold: boolean;
}

function createState(findings: ExecutionFinding[]): ScanState {
  return {
    findings,
    ends: new Map(),
    open: [],
    turnHasTruncated: false,
    turnHasRecovery: false,
    turnHasWaitingHold: false,
  };
}

function fieldsOf(event: ExecutionLogEvent): Record<string, unknown> {
  return event.payload ?? event.data ?? {};
}

function textField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clip(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function pushFinding(state: ScanState, event: ExecutionLogEvent, finding: Omit<ExecutionFinding, 'ts' | 'kind' | 'sessionId' | 'turn'> & { turn?: number }): void {
  state.findings.push({
    ts: event.ts ?? '',
    kind: event.kind,
    sessionId: event.sessionId,
    turn: finding.turn ?? state.turn,
    ...finding,
  });
}

function resetTurn(state: ScanState, turn: number | undefined): void {
  state.turn = turn;
  state.turnHasTruncated = false;
  state.turnHasRecovery = false;
  state.turnHasWaitingHold = false;
}

function flushOpen(state: ScanState, asWaiting: boolean): void {
  if (!asWaiting) {
    for (const start of state.open) {
      state.findings.push({
        code: 'tool_unpaired',
        ts: start.ts,
        kind: 'tool_start',
        message: `${start.name} started and never finished`,
        sessionId: start.sessionId,
        turn: start.turn,
        ...(start.toolCallId ? { toolCallId: start.toolCallId } : {}),
        name: start.name,
      });
    }
  }
  state.open = [];
}

function onTurnStart(state: ScanState, event: ExecutionLogEvent): void {
  flushOpen(state, false);
  const turn = fieldsOf(event).turn;
  resetTurn(state, typeof turn === 'number' ? turn : undefined);
}

function onToolStart(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  const id = textField(fields, 'toolCallId');
  const count = id ? state.ends.get(id) : undefined;
  if (id && count) {
    state.ends.set(id, count - 1);
    return;
  }
  state.open.push({
    ts: event.ts ?? '',
    sessionId: event.sessionId,
    turn: state.turn,
    name: textField(fields, 'name') ?? textField(fields, 'tool') ?? 'tool',
    toolCallId: textField(fields, 'toolCallId'),
  });
}

// Older logs may have only a name. Match it only when there is a single pending candidate.
function closeLegacyStart(state: ScanState, name: string | undefined): void {
  if (!name) return;
  const named = state.open.filter(start => start.name === name);
  if (named.length === 1) state.open.splice(state.open.indexOf(named[0]!), 1);
}

function noteWaitingHold(
  state: ScanState,
  event: ExecutionLogEvent,
  name: string | undefined,
  toolCallId: string | undefined
): void {
  state.turnHasWaitingHold = true;
  pushFinding(state, event, {
    code: 'waiting_approval',
    message: `Waiting for approval${name ? ` on ${name}` : ''}`,
    ...(toolCallId ? { toolCallId } : {}),
    ...(name ? { name } : {}),
  });
}

function noteToolFailed(
  state: ScanState,
  event: ExecutionLogEvent,
  name: string | undefined,
  toolCallId: string | undefined,
  code: string | undefined
): void {
  pushFinding(state, event, {
    code: 'tool_failed',
    message: `${name ?? 'tool'} failed${code ? ` (${code})` : ''}`,
    ...(toolCallId ? { toolCallId } : {}),
    ...(name ? { name } : {}),
  });
}

function onToolEnd(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  const toolCallId = textField(fields, 'toolCallId');
  const name = textField(fields, 'name') ?? textField(fields, 'tool');
  if (!toolCallId) closeLegacyStart(state, name);
  if (fields.hold === 'approval') {
    noteWaitingHold(state, event, name, toolCallId);
    return;
  }
  if (fields.ok === false) noteToolFailed(state, event, name, toolCallId, textField(fields, 'code'));
}

function onHardline(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  const name = textField(fields, 'tool') ?? textField(fields, 'name');
  const toolCallId = textField(fields, 'toolCallId');
  pushFinding(state, event, {
    code: 'tool_failed',
    message: `${name ?? 'tool'} failed (command_hardline_denied)`,
    ...(toolCallId ? { toolCallId } : {}),
    ...(name ? { name } : {}),
  });
}

function hasUsage(fields: Record<string, unknown>): boolean {
  const usage = fields.usage;
  if (!usage || typeof usage !== 'object') return false;
  const record = usage as Record<string, unknown>;
  return [record.inputTokens, record.outputTokens, record.totalTokens].some(
    (value) => typeof value === 'number' && Number.isFinite(value)
  );
}

function onTurnEnd(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  if (fields.terminal === true) {
    onTerminal(state, event, fields);
    return;
  }
  if (fields.truncated === true && !state.turnHasTruncated) {
    state.turnHasTruncated = true;
    pushFinding(state, event, { code: 'truncated', message: 'Model output was cut off by the token cap' });
  }
  if (!hasUsage(fields)) {
    pushFinding(state, event, { code: 'missing_usage', message: 'Turn finished without token usage' });
  }
}

function noteTerminalWait(state: ScanState, event: ExecutionLogEvent): void {
  flushOpen(state, true);
  if (state.turnHasWaitingHold) return;
  pushFinding(state, event, { code: 'waiting_approval', message: 'Run is waiting for approval' });
}

function noteTerminalStop(state: ScanState, event: ExecutionLogEvent, reason: string): void {
  flushOpen(state, false);
  if (!RECOVERY_REASONS.has(reason) || state.turnHasRecovery) return;
  state.turnHasRecovery = true;
  pushFinding(state, event, { code: 'recovery_stop', message: `Run stopped: ${reason}` });
}

function onTerminal(state: ScanState, event: ExecutionLogEvent, fields: Record<string, unknown>): void {
  const reason = textField(fields, 'reason') ?? '';
  if (reason === 'waiting_approval') {
    noteTerminalWait(state, event);
    return;
  }
  noteTerminalStop(state, event, reason);
}

function onTruncated(state: ScanState, event: ExecutionLogEvent): void {
  if (state.turnHasTruncated) return;
  state.turnHasTruncated = true;
  pushFinding(state, event, { code: 'truncated', message: 'Model output was cut off by the token cap' });
}

function onRecovery(state: ScanState, event: ExecutionLogEvent): void {
  state.turnHasRecovery = true;
  const reason = textField(fieldsOf(event), 'reason');
  pushFinding(state, event, {
    code: 'recovery_stop',
    message: reason ? `Run stopped: ${clip(reason)}` : `Run stopped (${event.kind})`,
  });
}

function onModelError(state: ScanState, event: ExecutionLogEvent): void {
  const message = textField(fieldsOf(event), 'message');
  pushFinding(state, event, {
    code: 'model_error',
    message: message ? `Model error: ${clip(message)}` : 'Model error',
  });
}

function onAdvisory(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  if (fields.trigger !== 'protocol_heal') return;
  const toolCallId = textField(fields, 'toolCallId');
  pushFinding(state, event, {
    code: 'tool_unpaired',
    message: 'A tool call had no result',
    ...(toolCallId ? { toolCallId } : {}),
  });
}

function onSkillLoad(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  if (fields.rejected !== true) return;
  const name = textField(fields, 'name') ?? textField(fields, 'skillName') ?? 'skill';
  const reason = textField(fields, 'reason') ?? 'rejected';
  pushFinding(state, event, {
    code: 'skill_rejected',
    message: `Skill ${name} rejected: ${reason}`,
    name,
  });
}

function onGoalEval(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  if (fields.met !== false) return;
  const reason = textField(fields, 'reason') ?? 'goal not met';
  const goal = textField(fields, 'title') ?? textField(fields, 'goal');
  pushFinding(state, event, {
    code: 'goal_not_met',
    message: goal ? `Goal not met (${clip(goal)}): ${clip(reason)}` : `Goal not met: ${clip(reason)}`,
  });
}

function onApproval(state: ScanState, event: ExecutionLogEvent): void {
  const fields = fieldsOf(event);
  if (fields.decision !== 'rejected') return;
  const name = textField(fields, 'toolName');
  const approvalId = textField(fields, 'approvalId');
  const who = name ? ` for ${name}` : '';
  const id = approvalId ? ` (${approvalId})` : '';
  pushFinding(state, event, {
    code: 'approval_rejected',
    message: `Approval rejected${who}${id}`,
    ...(name ? { name } : {}),
  });
}

const HANDLERS: Record<string, (state: ScanState, event: ExecutionLogEvent) => void> = {
  turn_start: onTurnStart,
  tool_start: onToolStart,
  tool_end: onToolEnd,
  command_hardline_denied: onHardline,
  turn_end: onTurnEnd,
  turn_truncated: onTruncated,
  model_error: onModelError,
  recovery_advisory: onAdvisory,
  skill_load: onSkillLoad,
  goal_eval: onGoalEval,
  approval_decision: onApproval,
};

function dispatch(state: ScanState, event: ExecutionLogEvent): void {
  if (RECOVERY_KINDS.has(event.kind)) {
    onRecovery(state, event);
    return;
  }
  HANDLERS[event.kind]?.(state, event);
}

export function analyzeExecutionLog(events: readonly ExecutionLogEvent[]): ExecutionFinding[] {
  const findings: ExecutionFinding[] = [];
  const sessions = new Map<string | undefined, ScanState>();
  // A tool end may be appended before its start or across a turn boundary.
  for (const event of events) {
    let state = sessions.get(event.sessionId);
    if (!state) {
      state = createState(findings);
      sessions.set(event.sessionId, state);
    }
    if (event.kind !== 'tool_end') continue;
    const id = textField(fieldsOf(event), 'toolCallId');
    if (id) state.ends.set(id, (state.ends.get(id) ?? 0) + 1);
  }
  for (const event of events) dispatch(sessions.get(event.sessionId)!, event);
  for (const state of sessions.values()) flushOpen(state, false);
  return findings;
}

export function attachExecutionFindings<T extends { events: readonly ExecutionLogEvent[] }>(
  page: T
): T & { findings: ExecutionFinding[] } {
  return { ...page, findings: analyzeExecutionLog(page.events) };
}
