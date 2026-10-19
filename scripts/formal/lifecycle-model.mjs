/** Finite explicit-state design model. Separate from implementation evidence. */
export const SCOPE = {
  checker: 'session-lifecycle-explicit-state/1',
  bounds: { modes: ['chat', 'task'], sequentialRuns: 2, approvalsPerRun: 2, retriesPerRun: 1, toolWavesPerRun: 1 },
  assumptions: ['One process and one active writer per session.', 'Cancellation does not undo external effects; already recorded terminal results are immutable.', 'Retry means model request retry, not replay of successful tool work.', 'Each synchronous decision/record operation is atomic; await boundaries are distinct events.'],
  exclusions: ['unbounded runs/retries', 'process kill, power loss, corrupted storage', 'multiple-process writers', 'live upstreams, UI rendering and arbitrary external tool effects'],
};
function init(mode) { return { mode, run: 1, stage: 'model', status: 'running', outcome: null, attempt: 0, approvals: [], executed: [0, 0], cancelled: false, history: [] }; }
function events(s) {
  const out = [{ type: 'cancel', run: s.run }];
  if (s.run === 2) for (const type of ['cancel', 'model-return', 'retry-tick', 'approve']) out.push({ type, run: 1 });
  if (s.stage === 'ended') {
    for (const type of ['model-return', 'retry-tick', 'approve']) out.push({ type, run: s.run });
    if (s.run < 2) out.push({ type: 'start-next', run: 2 });
  }
  if (s.stage === 'model') for (const type of ['model-return', 'model-error', 'request-approval']) out.push({ type, run: s.run });
  if (s.stage === 'retry') out.push({ type: 'retry-tick', run: s.run });
  if (s.stage === 'waiting') {
    s.approvals.forEach((a, index) => { if (a === 'pending') for (const type of ['approve', 'reject']) out.push({ type, run: s.run, index }); });
    if (s.approvals.every(a => a !== 'pending')) out.push({ type: 'resume', run: s.run });
  }
  if (s.stage === 'tools') out.push({ type: 'model-return', run: s.run });
  return out;
}
function step(old, e, fault) {
  const s = structuredClone(old);
  if (e.type === 'start-next') { const next = init(s.mode); return { ...next, run: 2, history: [...s.history, { run: s.run, outcome: s.outcome }] }; }
  if (e.run !== s.run || s.stage === 'ended') return s;
  const end = kind => { s.stage = 'ended'; s.outcome = kind; s.status = kind === 'aborted' || kind === 'failed' ? 'failed' : kind; s.approvals = []; };
  if (e.type === 'cancel') { s.cancelled = true; end('aborted'); if (fault === 'cancel') { s.stage = 'model'; s.status = 'running'; } }
  if (e.type === 'model-return') end(s.mode === 'task' ? 'completed' : 'idle');
  if (e.type === 'model-error') {
    if (s.attempt === 0) s.stage = 'retry';
    else { end('failed'); if (fault === 'retry') s.status = 'running'; }
  }
  if (e.type === 'retry-tick') { s.attempt++; s.stage = 'model'; }
  if (e.type === 'request-approval') { s.stage = 'waiting'; s.status = 'waiting_approval'; s.approvals = ['pending', 'pending']; }
  if (e.type === 'approve' || e.type === 'reject') s.approvals[e.index] = e.type === 'approve' ? 'approved' : 'rejected';
  if (e.type === 'resume') {
    s.approvals.forEach((a, i) => { if (a === 'approved') s.executed[i] += fault === 'approval' ? 2 : 1; });
    s.stage = 'tools'; s.status = 'running';
  }
  return s;
}
function check(s) {
  const issues = [];
  if (s.cancelled && s.stage !== 'ended') issues.push('cancelled run continued');
  if (s.stage === 'ended' && (['running', 'waiting_approval'].includes(s.status) || !s.outcome || s.approvals.includes('pending'))) issues.push('terminal outcome with active state');
  if (s.stage === 'ended' && s.status !== (s.outcome === 'aborted' ? 'failed' : s.outcome)) issues.push('status/outcome mismatch');
  if (s.stage === 'ended' && ((s.outcome === 'idle' && s.mode !== 'chat') || (s.outcome === 'completed' && s.mode !== 'task'))) issues.push('mode/completion mismatch');
  if (s.stage === 'waiting' && s.status !== 'waiting_approval') issues.push('approval wait lost');
  if (s.executed.some(n => n > 1)) issues.push('approved operation repeated');
  if (s.approvals.some((a, i) => a === 'rejected' && s.executed[i] > 0)) issues.push('rejected operation executed');
  return { ok: issues.length === 0, run: s.run, status: s.status, outcome: s.outcome, issues };
}
export function replayLifecycle(trace, { fault } = {}) {
  let s = init(trace[0].mode);
  for (const e of trace.slice(1)) {
    if (!events(s).some(x => JSON.stringify(x) === JSON.stringify(e))) throw new Error('Invalid replay event');
    s = step(s, e, fault);
  }
  return check(s);
}
export function exploreLifecycleModel({ fault, maxStates = 100000 } = {}) {
  const queue = SCOPE.bounds.modes.map(mode => ({ s: init(mode), events: [{ type: 'start', mode }] }));
  const seen = new Set(queue.map(x => JSON.stringify(x.s)));
  let transitions = 0;
  for (let index = 0; index < queue.length; index++) {
    const row = queue[index];
    for (const e of events(row.s)) {
      transitions++;
      const s = step(row.s, e, fault), verification = check(s);
      if (e.type !== 'start-next' && (e.run !== row.s.run || row.s.stage === 'ended') && JSON.stringify(s) !== JSON.stringify(row.s)) {
        verification.ok = false; verification.issues.push('late event changed an ended or newer run');
      }
      const trace = [...row.events, e];
      if (!verification.ok) return { status: 'fail', exhausted: false, states: seen.size, transitions, scope: SCOPE, counterexample: { events: trace, check: verification } };
      const key = JSON.stringify(s);
      if (!seen.has(key)) {
        if (seen.size >= maxStates) return { status: 'incomplete', exhausted: false, states: seen.size, transitions, scope: SCOPE, reason: 'state limit' };
        seen.add(key); queue.push({ s, events: trace });
      }
    }
  }
  return { status: 'pass', exhausted: true, states: seen.size, transitions, scope: SCOPE };
}
