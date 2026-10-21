/** Hermetic public runtime exercises: real kernel, retry, approval APIs and SQLite; controlled model/tools only. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for (const method of ['log', 'info', 'debug']) console[method] = (...args) => console.error(...args);
// Existing process settings, scoped to this disposable probe; no .env or persisted user settings.
process.env.RAW_AGENT_MODEL_MAX_RETRIES = '1';
process.env.RAW_AGENT_AGENTS_SKILLS = '0';
const { RawAgentRuntime } = await import('../../packages/core/dist/exports/public.js');
const text = () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] });
const toolTurn = () => ({ stopReason: 'tool_use', assistantParts: ['a', 'b'].map(id => ({ type: 'tool_call', toolCallId: id, name: `lifecycle_${id}`, input: { token: id } })) });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function snapshot(h) {
  const s = h.rt.getSession(h.sid);
  return {
    run: `run-${h.runNumber}`, status: s.status, outcome: s.metadata?.outcome ? { kind: s.metadata.outcome.kind, reason: s.metadata.outcome.reason } : null,
    interrupt: !!s.metadata?.interrupt,
    approvals: h.rt.listApprovals().filter(a => a.sessionId === h.sid).map(a => ({ tool: a.toolName, decision: a.status })).sort((a, b) => a.tool.localeCompare(b.tool)),
    executed: [...h.executed], modelCalls: h.modelCalls,
  };
}
const rows = [];
async function scenario(name, fn, { mode = 'chat', approval = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-runtime-'));
  mkdirSync(join(dir, 'repo'));
  const h = { sid: '', runNumber: 1, executed: [], modelCalls: 0, events: [], snapshots: [], checks: [], model: async () => text(), tool: async (_ctx, args) => ({ ok: true, content: args.token }) };
  h.check = (label, ok, expected, actual) => h.checks.push({ label, ok: !!ok, expected, actual });
  h.snap = event => { h.events.push(event); const s = snapshot(h); h.snapshots.push(s); return s; };
  h.rt = new RawAgentRuntime({ repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'), modelAdapter: {
    name: 'lifecycle-controlled', runTurn: input => { h.modelCalls++; return h.model(input, h.modelCalls); }, summarizeMessages: async () => '', completeText: async () => '{"met":true,"reason":"probe"}',
  }, extraTools: ['a', 'b'].map(id => ({ name: `lifecycle_${id}`, description: 'Local lifecycle probe', inputSchema: { type: 'object' }, approvalMode: approval ? 'always' : 'never', sideEffectLevel: 'none', execute: async (ctx, args) => { h.executed.push(id); return h.tool(ctx, args); } })) });
  h.rt.store.setDaemonControl('tool_exposure_settings', {mode:'full',pinnedGroups:{}});
  const input = { title: name, message: 'run local probe', background: false };
  h.sid = mode === 'task' ? h.rt.createTaskSession(input).session.id : h.rt.createChatSession(input).id;
  h.run = async options => {
    h.events.push(`run-${h.runNumber}: start/resume`);
    try { const out = await h.rt.runSession(h.sid, options); h.check('returned status equals stored status', out.status === h.rt.getSession(h.sid).status, h.rt.getSession(h.sid).status, out.status); return out; }
    catch (error) { h.events.push(`run-${h.runNumber}: rejected ${error.message}`); return undefined; }
  };
  h.cancelled = () => {
    const s = h.snap('settled cancellation');
    h.check('cancelled outcome and no running/approval latch', s.outcome?.kind === 'aborted' && ['idle', 'failed'].includes(s.status) && !s.interrupt && !s.approvals.some(a => a.decision === 'pending'), 'aborted; no active state or pending approval', s);
  };
  const originalTimer = globalThis.setTimeout;
  try { await fn(h); }
  finally {
    globalThis.setTimeout = originalTimer;
    await h.rt.destroy(); rmSync(dir, { recursive: true, force: true });
  }
  rows.push({ name, status: h.checks.length && h.checks.every(c => c.ok) ? 'pass' : 'fail', events: h.events, snapshots: h.snapshots, checks: h.checks });
}
function terminal(h, expected) {
  const s = h.snap('run settled');
  h.check('terminal status, outcome and latch agree', s.status === expected && s.outcome?.kind === expected && !s.interrupt, expected, s);
}
function observeRetry() {
  const wait = deferred(), original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay, ...args) => { const timer = original(fn, delay, ...args); if (delay === 2000) wait.resolve(); return timer; };
  return wait.promise;
}
async function park(h) { h.model = async (_input, n) => n === 1 ? toolTurn() : text(); await h.run(); return h.rt.listApprovals().filter(a => a.sessionId === h.sid).sort((a, b) => a.toolName.localeCompare(b.toolName)); }
async function cancelAt(h, phase) {
  if (phase === 'approval') { await park(h); h.snap('waiting approval'); h.rt.cancelSession(h.sid); h.cancelled(); return; }
  const entered = deferred(), release = deferred();
  if (phase === 'model') h.model = async () => { entered.resolve(); await release.promise; return text(); };
  if (phase === 'tool') { h.model = async (_i, n) => n === 1 ? toolTurn() : text(); h.tool = async () => { entered.resolve(); await release.promise; return { ok: true, content: 'late tool result' }; }; }
  let waiting;
  if (phase === 'retry') { waiting = observeRetry(); h.model = async (_i, n) => { if (n === 1) throw new Error('probe retryable failure'); return text(); }; }
  const active = h.run();
  await (phase === 'retry' ? waiting : entered.promise);
  h.snap(`cancel at ${phase}`); h.rt.cancelSession(h.sid); release.resolve(); await active; h.cancelled();
  h.check('no new model work after cancellation', h.modelCalls === 1, 1, h.modelCalls);
}
try {
  for (const mode of ['chat', 'task']) await scenario(mode, async h => { await h.run(); terminal(h, mode === 'task' ? 'completed' : 'idle'); }, { mode });
  for (const phase of ['model', 'tool', 'retry', 'approval']) await scenario(`cancel-${phase}`, h => cancelAt(h, phase), { approval: phase === 'approval' });
  for (const end of ['completed', 'failed', 'aborted']) await scenario(`late-cancel-${end}`, async h => {
    if (end === 'failed') h.model = async () => { throw new Error('persistent model failure'); };
    if (end === 'aborted') await cancelAt(h, 'model'); else await h.run();
    const before = h.snap('old run ended');
    h.check('precondition: expected old outcome reached', before.outcome?.kind === end, end, before.outcome);
    h.rt.cancelSession(h.sid); const after = h.snap('late duplicate cancel');
    h.check('late cancel cannot rewrite recorded outcome', JSON.stringify(before) === JSON.stringify(after), before, after);
  }, { mode: end === 'completed' ? 'task' : 'chat' });
  await scenario('old-signal-new-run', async h => {
    const old = new AbortController(); await h.run({ signal: old.signal });
    h.runNumber = 2; h.rt.sendUserMessage(h.sid, 'next');
    const entered = deferred(), release = deferred(); h.model = async () => { entered.resolve(); await release.promise; return text(); };
    const active = h.run(); await entered.promise; const before = h.snap('new run waiting'); old.abort(); const after = h.snap('old caller signal aborts');
    h.check('old signal leaves new run unchanged', JSON.stringify(before) === JSON.stringify(after), before, after);
    release.resolve(); await active; terminal(h, 'idle');
  });
  await scenario('old-approval-new-run', async h => {
    const approvals = await park(h); h.rt.cancelSession(h.sid); h.cancelled();
    h.runNumber = 2; h.rt.sendUserMessage(h.sid, 'next');
    const entered = deferred(), release = deferred(); h.model = async () => { entered.resolve(); await release.promise; return text(); };
    const active = h.run(); await entered.promise; const before = h.snap('new run waiting');
    for (const a of approvals) await h.rt.approve(a.id, 'approved');
    const after = h.snap('old approval arrives'); h.check('old approval leaves new run unchanged', JSON.stringify(before) === JSON.stringify(after), before, after);
    release.resolve(); await active; terminal(h, 'idle');
  }, { approval: true });
  await scenario('old-retry-new-run', async h => {
    await cancelAt(h, 'retry');
    h.runNumber = 2; h.rt.sendUserMessage(h.sid, 'next'); h.model = async () => text(); await h.run(); terminal(h, 'idle');
    const before = h.snap('new run ended');
    // The real retry timer is cleared on abort. Wait beyond its original due time to detect leaked callbacks.
    await new Promise(r => setTimeout(r, 2050));
    const after = h.snap('old retry due time passed'); h.check('old retry did not start another request', JSON.stringify(before) === JSON.stringify(after), before, after);
  });
  for (const kind of ['success', 'exhausted', 'after-tool']) await scenario(`retry-${kind}`, async h => {
    const waiting = observeRetry();
    h.model = async (_i, n) => {
      if (kind === 'after-tool' && n === 1) return toolTurn();
      if (kind === 'exhausted' || n === (kind === 'after-tool' ? 2 : 1)) throw new Error('probe retryable failure');
      return text();
    };
    const active = h.run(); await waiting;
    const s = h.snap('retry waiting'); h.check('retry is still running', s.status === 'running', 'running', s.status);
    await active; terminal(h, kind === 'exhausted' ? 'failed' : 'idle');
    h.check('one retry, no tool replay', h.modelCalls === (kind === 'after-tool' ? 3 : 2) && h.executed.length === (kind === 'after-tool' ? 2 : 0), { models: kind === 'after-tool' ? 3 : 2, tools: kind === 'after-tool' ? 2 : 0 }, { models: h.modelCalls, tools: h.executed.length });
  });
  for (const variant of ['wait', 'partial', 'resume', 'mixed', 'rejected']) await scenario(`approval-${variant}`, async h => {
    const approvals = await park(h);
    h.check('two real approval records', approvals.length === 2, 2, approvals.length);
    if (approvals.length !== 2) return;
    if (variant === 'wait') { const s = h.snap('waiting for both'); h.check('approval wait with no execution', s.status === 'waiting_approval' && s.interrupt && s.outcome?.kind === 'waiting_approval' && h.executed.length === 0, 'waiting_approval', s); return; }
    await h.rt.approve(approvals[0].id, variant === 'rejected' ? 'rejected' : 'approved');
    if (variant === 'partial') { const s = h.snap('only first approval decided'); h.check('partial decision stays waiting', s.status === 'waiting_approval' && s.outcome?.kind === 'waiting_approval' && h.executed.length === 0, 'waiting_approval', s); await h.run(); h.snap('resume while second pending'); h.check('still no execution', h.executed.length === 0, 0, h.executed.length); return; }
    await h.rt.approve(approvals[1].id, variant === 'resume' ? 'approved' : 'rejected');
    await h.run(); terminal(h, 'idle');
    const expected = variant === 'resume' ? ['a', 'b'] : variant === 'mixed' ? ['a'] : [];
    h.check('only approved operations execute once', JSON.stringify(h.executed) === JSON.stringify(expected), expected, h.executed);
    if (variant !== 'resume') {
      const rejected = h.rt.getSessionMessages(h.sid).flatMap(m => m.parts).filter(p => p.type === 'tool_result' && !p.ok && /reject/i.test(p.content));
      h.check('rejections recorded', rejected.length === (variant === 'rejected' ? 2 : 1), variant === 'rejected' ? 2 : 1, rejected.length);
    }
    const before = h.snap('before repeat decision');
    for (const a of approvals) await h.rt.approve(a.id, 'approved');
    const after = h.snap('repeat decision'); h.check('duplicate decision is inert', JSON.stringify(before) === JSON.stringify(after), before, after);
  }, { approval: true });
  const status = rows.every(x => x.status === 'pass') ? 'pass' : 'fail';
  process.stdout.write(JSON.stringify({ completed: true, engine: 'RawAgentRuntime/SQLite/agent-loop', status, scenarios: rows }));
  process.exitCode = status === 'pass' ? 0 : 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ completed: false, status: 'incomplete', reason: error.stack, scenarios: rows })); process.exitCode = 2;
}
