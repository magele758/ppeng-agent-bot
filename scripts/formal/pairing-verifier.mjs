/** Bounded explicit-state specification checker + independent source probes. No product imports are patched in place. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SCOPE = Object.freeze({
  checker: 'pairing-explicit-state/1',
  properties: ['one result per call occurrence', 'prior matching call', 'result provenance', 'pending is not completed'],
  bounds: { calls: 2, retriesPerCall: 1, approvalWaitsPerCall: 1, duplicateBatchesPerCall: 1, duplicateDeliveriesPerCall: 1 },
  assumptions: [
    'One writer; synchronous append of a message is indivisible; no callback re-entry into persistence.',
    'The model starts after two distinct call ids are recorded in one wave; all enabled event orders are explored.',
    'Success, failure, unknown-tool and rejection abstract arbitrary payloads; retry occurs before persistence.',
    'Cancellation closes outstanding calls; a normal end requires all calls settled; no liveness claim.',
    'The design model specifies deduplication even within a returned batch; source probes independently check that promise.',
  ],
  exclusions: ['process kill, power loss, storage corruption', 'multiple writers and external side effects',
    'unbounded calls/retries', 'full kernel, database, network and UI execution; source probes cover the mapped component boundary'],
});
const hash = text => createHash('sha256').update(text).digest('hex');
const call = id => ({ type: 'tool_call', toolCallId: id, name: 'echo', input: { token: id } });
const result = (id, outcome = 'success') => ({ type: 'tool_result', toolCallId: id, name: 'echo', ok: outcome === 'success', content: outcome === 'success' ? `origin:${id}` : outcome });

/** Independent occurrence-aware oracle (ids may be reused only after their prior occurrence closes). */
export function inspectTranscript(messages, phase) {
  if (!['running', 'waiting_approval', 'ended'].includes(phase)) throw new Error(`Unknown phase: ${phase}`);
  const open = new Map(), seen = new Set(), issues = [];
  const parts = messages.flatMap(m => m.parts);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], id = part.toolCallId;
    if (part.type === 'tool_call') {
      if (!id || open.has(id)) issues.push({ code: 'overlapping-call-id', id, index });
      open.set(id, part); seen.add(id);
    } else if (part.type === 'tool_result') {
      const prior = open.get(id);
      if (!prior) issues.push({ code: seen.has(id) ? 'duplicate-result' : 'orphan-result', id, index });
      else {
        if (prior.name !== part.name || (part.content?.startsWith('origin:') && part.content !== `origin:${prior.input.token}`)) {
          issues.push({ code: 'misassociated-result', id, index });
        }
        if (typeof part.ok !== 'boolean' || typeof part.content !== 'string' || (!part.ok && !part.content.trim())) {
          issues.push({ code: 'ambiguous-result', id, index });
        }
        open.delete(id);
      }
    }
  }
  if (phase === 'ended') for (const id of open.keys()) issues.push({ code: 'missing-result', id });
  return { status: issues.length ? 'violation' : phase === 'ended' ? 'complete' : 'pending', pending: [...open.keys()], issues };
}

function initial() {
  return { phase: 'running', slots: ['a', 'b'].map(id => ({ id, stage: 'open', retried: false, waited: false, duplicated: false })), parts: [call('a'), call('b')] };
}
function enabled(s) {
  if (s.phase === 'ended') return [];
  const events = [{ type: 'cancel' }];
  if (s.slots.every(x => x.stage === 'done')) events.push({ type: 'finish' });
  for (const x of s.slots) {
    const add = type => events.push({ type, id: x.id });
    if (x.stage === 'open') {
      for (const type of ['success', 'failure', 'unknown']) add(type);
      if (!x.retried) add('retry');
      if (!x.waited) add('wait');
    }
    if (x.stage === 'waiting') { add('approve'); add('reject'); }
    if (x.stage === 'ready') { add('deliver'); add('duplicate-batch'); }
    if (x.stage === 'done' && !x.duplicated) add('duplicate-delivery');
  }
  return events;
}
function advance(state, event, fault) {
  const s = structuredClone(state), x = s.slots.find(x => x.id === event.id);
  const append = (slot, outcome) => {
    const r = result(slot.id, outcome);
    if (fault === 'missing') return;
    if (fault === 'misassociated') r.toolCallId = slot.id === 'a' ? 'b' : 'a';
    s.parts.push(r);
  };
  switch (event.type) {
    case 'cancel':
      for (const slot of s.slots) if (slot.stage !== 'done') { append(slot, 'cancelled'); slot.stage = 'done'; }
      s.phase = 'ended'; break;
    case 'finish': s.phase = 'ended'; break;
    case 'wait': x.stage = 'waiting'; x.waited = true; break;
    case 'approve': x.stage = 'open'; break;
    case 'retry': x.retried = true; break;
    case 'success': case 'failure': case 'unknown': case 'reject': x.stage = 'ready'; x.outcome = event.type; break;
    case 'deliver': case 'duplicate-batch':
      append(x, x.outcome); x.stage = 'done';
      if (event.type === 'duplicate-batch' && fault === 'duplicate') append(x, x.outcome);
      break;
    case 'duplicate-delivery':
      x.duplicated = true;
      if (fault === 'duplicate') append(x, x.outcome);
      break;
    default: throw new Error(`Unknown model event ${event.type}`);
  }
  return s;
}
export function replayModel(events, { fault } = {}) {
  let s = initial();
  for (const e of events) {
    if (!enabled(s).some(x => JSON.stringify(x) === JSON.stringify(e))) throw new Error('Invalid counterexample event');
    s = advance(s, e, fault);
  }
  return inspectTranscript([{ parts: s.parts }], s.phase);
}
export function exploreModel({ fault, maxStates = 200000 } = {}) {
  const queue = [{ state: initial(), events: [] }], seen = new Set([JSON.stringify(queue[0].state)]);
  let transitions = 0, terminalStates = 0;
  for (let i = 0; i < queue.length; i++) {
    const { state, events } = queue[i];
    if (state.phase === 'ended') terminalStates++;
    for (const e of enabled(state)) {
      transitions++;
      const next = advance(state, e, fault), check = inspectTranscript([{ parts: next.parts }], next.phase);
      if (check.status === 'violation') return { status: 'fail', exhausted: false, states: seen.size, transitions, scope: SCOPE, counterexample: { events: [...events, e], check, parts: next.parts } };
      const key = JSON.stringify(next);
      if (!seen.has(key)) {
        if (seen.size >= maxStates) return { status: 'incomplete', exhausted: false, states: seen.size, transitions, scope: SCOPE, reason: 'state budget exhausted' };
        seen.add(key); queue.push({ state: next, events: [...events, e] });
      }
    }
  }
  return { status: 'pass', exhausted: true, states: seen.size, transitions, terminalStates, scope: SCOPE };
}

const LOOP = 'packages/agent-loop/src/runtime/tool-loop.ts';
const MUTATIONS = {
  missing: ['host.appendMessage(session.id, \'tool\', parts);', '/* deliberately omit result persistence */'],
  duplicate: ['host.appendMessage(session.id, \'tool\', parts);', 'host.appendMessage(session.id, \'tool\', parts); host.appendMessage(session.id, \'tool\', parts);'],
  misassociated: ['toolCallId: r.toolCallId,', "toolCallId: 'wrong-call-id',"],
};

/** Transpile the actual source dependency closure into a disposable directory, never use possibly stale dist. */
async function sourceCopy(mutation) {
  const ts = await import('typescript');
  if (ts.version !== '5.9.3') throw new Error(`Needs TypeScript 5.9.3, got ${ts.version}; pnpm install --frozen-lockfile`);
  const dir = mkdtempSync(join(tmpdir(), 'pairing-source-'));
  const built = new Set();
  let evidence;
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    function compile(rel) {
      const output = join(dir, rel.replace(/\.ts$/, '.js'));
      if (built.has(rel)) return output;
      built.add(rel);
      let source = readFileSync(join(ROOT, rel), 'utf8');
      if (mutation && rel === LOOP) {
        const [from, to] = MUTATIONS[mutation];
        if (source.split(from).length !== 2) throw new Error(`Mutation anchor drift: ${mutation}`);
        const changed = source.replace(from, to);
        evidence = { file: rel, from, to, sourceBefore: hash(source), sourceAfter: hash(changed) };
        source = changed;
      }
      const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
      if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Cannot transpile ${rel}`);
      const js = compiled.outputText.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g, (full, prefix, quote, spec) => {
        const dependency = resolve(ROOT, dirname(rel), spec).slice(ROOT.length + 1).replace(/\.js$/, '.ts');
        if (dependency.startsWith('..') || !dependency.startsWith('packages/agent-loop/src/')) throw new Error(`Unmapped source dependency ${dependency}`);
        compile(dependency);
        return full;
      });
      mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, js);
      return output;
    }
    const loop = await import(pathToFileURL(compile(LOOP)).href);
    const close = await import(pathToFileURL(compile('packages/agent-loop/src/session/tool-wave-close.ts')).href);
    const recovery = await import(pathToFileURL(compile('packages/agent-loop/src/recovery/pair-unmatched-tool-calls.ts')).href);
    return { loop, close, recovery, evidence, files: [...built].sort(), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

function harness(api, calls = [call('a')]) {
  const messages = [{ role: 'assistant', parts: structuredClone(calls) }], approvals = [];
  const session = { id: 'pairing-probe', metadata: {} };
  const appendMessage = (_sid, role, parts) => { const m = { role, parts: structuredClone(parts) }; messages.push(m); return m; };
  const host = {
    env: {}, appendMessage, listApprovals: () => approvals,
    createApproval: input => { const a = { ...input, id: 'approval', status: 'pending', createdAt: '2026-01-01T00:00:00Z' }; approvals.push(a); return a; },
    deleteApproval: () => {}, getTask: () => undefined, updateTask: () => {}, emitTrace: () => {},
    pairedToolCallIds: () => api.loop.pairedToolCallIdsFromMessages(messages),
  };
  const tools = [{ name: 'echo', description: 'probe', inputSchema: {}, approvalMode: 'never', sideEffectLevel: 'none', execute: async (_ctx, input) => ({ ok: true, content: `origin:${input.token}` }) }];
  const context = { session, abortSignal: new AbortController().signal };
  const persist = results => api.loop.processToolResults(host, api.loop.resultsToPersist(results), calls, session, undefined, session.id);
  return { messages, approvals, session, host, tools, context, persist, calls, store: { foldMessages: () => messages, appendMessage } };
}

async function sourceScenarios(api) {
  const rows = [];
  const run = async (name, action, calls, phase = 'ended') => {
    const h = harness(api, calls), events = ['record calls'];
    await action(h, events);
    const check = inspectTranscript(h.messages, phase);
    rows.push({ name, ...check, events, messages: h.messages });
  };
  const execute = async h => api.loop.executeToolCalls(h.host, h.tools, h.calls, h.context, false, h.session.id, 2);
  await run('normal', async (h, e) => { h.persist(await execute(h)); e.push('execute echo', 'persist results', 'finish'); });
  await run('parallel-reversed', async (h, e) => { const results = await execute(h); h.persist(results.reverse()); e.push('execute a and b', 'persist b then a', 'finish'); }, [call('a'), call('b')]);
  await run('failure', async (h, e) => { h.tools[0].execute = async () => { throw new Error('probe failure'); }; h.persist(await execute(h)); e.push('tool throws', 'persist failure', 'finish'); });
  await run('unknown', async (h, e) => { h.tools.length = 0; h.persist(await execute(h)); e.push('unknown tool', 'persist failure', 'finish'); });
  await run('rejected', async (h, e) => {
    h.tools[0].approvalMode = 'always';
    const check = () => api.loop.checkToolApprovals(h.host, h.tools, h.calls, h.context, undefined, h.session);
    if (check() !== 'waiting') throw new Error('Approval probe never waited');
    h.approvals[0].status = 'rejected'; check(); e.push('wait for approval', 'reject approval', 'record rejection', 'finish');
  });
  await run('cancelled', async (h, e) => { api.close.closeOpenToolWave(h.store, h.session.id, 'interrupted'); api.close.closeOpenToolWave(h.store, h.session.id, 'interrupted'); e.push('cancel wave', 'repeat closure', 'finish'); }, [call('a'), call('b')]);
  await run('retry', async (h, e) => {
    await execute(h); h.persist(await execute(h)); e.push('execute without persisting', 'retry execution', 'persist once', 'finish');
  });
  await run('duplicate-delivery', async (h, e) => { const r = await execute(h); h.persist(r); h.persist(r); e.push('execute', 'persist', 'deliver again', 'finish'); });
  await run('duplicate-batch', async (h, e) => { const r = await execute(h); h.persist([...r, ...r]); e.push('execute a', 'deliver same result twice in one batch', 'finish'); });
  await run('reused-id', async (h, e) => { h.persist(await execute(h)); h.messages.push({ role: 'assistant', parts: structuredClone(h.calls) }); h.persist(await execute(h)); e.push('complete a', 'new call reuses a', 'complete second a', 'finish'); });
  await run('recovery', async (h, e) => { api.recovery.ensureFoldToolCallsPaired({ foldMessages: () => h.messages, appendMessage: (role, parts) => h.host.appendMessage(h.session.id, role, parts) }); e.push('recover unpaired call', 'finish'); });
  await run('running', async (_h, e) => { e.push('tool still executing'); }, undefined, 'running');
  await run('waiting-approval', async (h, e) => { h.tools[0].approvalMode = 'always'; if (api.loop.checkToolApprovals(h.host, h.tools, h.calls, h.context, undefined, h.session) !== 'waiting') throw new Error('Expected approval hold'); e.push('wait for approval'); }, undefined, 'waiting_approval');
  return rows;
}
export async function verifySource({ mutation } = {}) {
  const api = await sourceCopy(mutation);
  try {
    const scenarios = await sourceScenarios(api);
    return { status: scenarios.some(x => x.status === 'violation') ? 'fail' : 'pass', scenarios, files: api.files, mutation: api.evidence };
  } finally { api.cleanup(); }
}
export async function verifyMutations() {
  const before = await verifySource(), mutants = [];
  for (const name of Object.keys(MUTATIONS)) {
    const r = await verifySource({ mutation: name });
    // A pre-existing failing case cannot kill a mutant: require a NEW failure in a baseline-green scenario.
    const counterexample = r.scenarios.find(x => x.status === 'violation' && before.scenarios.find(b => b.name === x.name)?.status !== 'violation');
    mutants.push({ name, killed: !!counterexample, counterexample, ...r.mutation });
  }
  const after = await verifySource();
  return { status: mutants.every(x => x.killed) && JSON.stringify(before) === JSON.stringify(after) ? 'pass' : 'fail', mutants, restored: JSON.stringify(before) === JSON.stringify(after), baselineStatus: before.status };
}

export function checkReview({ read = path => readFileSync(path, 'utf8') } = {}) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'specs/formal/pairing-review.json'), 'utf8'));
  const missing = manifest.mapping.flatMap(row => row.files).filter(path => !manifest.sha256[path]);
  const changed = Object.entries(manifest.sha256).filter(([path, expected]) => {
    try { return hash(read(join(ROOT, path))) !== expected; } catch { return true; }
  }).map(([path]) => path);
  return { status: changed.length || missing.length ? 'needs-review' : 'reviewed', changed: [...new Set([...changed, ...missing])], mapping: manifest.mapping };
}

export function runVerificationProcess({ executable = process.execPath, worker = join(ROOT, 'scripts/formal/pairing-worker.mjs'), timeoutMs = 60000 } = {}) {
  // Deliberate allowlist: no model keys, dotenv settings, NODE_OPTIONS or host feature flags.
  const env = sanitizeScriptEnv({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP });
  const child = spawnSync(executable, [worker], { cwd: ROOT, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (child.error || child.signal) return { status: 'incomplete', exitCode: 2, reason: child.error?.message ?? child.signal };
  try {
    const report = JSON.parse(child.stdout);
    if (report.schema !== 1 || !['pass', 'fail', 'incomplete'].includes(report.status)) throw new Error('missing/invalid completion report');
    if (report.status !== 'incomplete' && (!report.model || !report.source || !report.mutations || !report.review || !report.negativeControls)) throw new Error('missing verification stages');
    if (report.status === 'pass' && (report.model.status !== 'pass' || !report.model.exhausted || report.source.status !== 'pass' || report.mutations.status !== 'pass' || !report.mutations.restored || report.review.status !== 'reviewed' || report.negativeControls.length !== 3 || report.negativeControls.some(x => x.result.status !== 'fail'))) throw new Error('inconsistent pass report');
    const expected = report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2;
    if (child.status !== expected) throw new Error('worker exit/report mismatch');
    return { ...report, exitCode: expected };
  } catch (error) { return { status: 'incomplete', exitCode: 2, reason: `${error.message}; ${child.stderr.slice(0, 1000)}` }; }
}
