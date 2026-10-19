/** Disposable runtime service: production constructor/kernel/store/shutdown, controlled I/O only. */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const key of ['log', 'info', 'debug']) console[key] = (...args) => console.error(...args);
process.env.RAW_AGENT_MODEL_MAX_RETRIES = '1';
process.env.RAW_AGENT_AGENTS_SKILLS = '0';
const config = JSON.parse(process.argv[2]);
const { RawAgentRuntime } = await import('../../packages/core/dist/exports/public.js');
const text = () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] });
const tools = ids => ({ stopReason: 'tool_use', assistantParts: ids.map(id => ({ type: 'tool_call', toolCallId: id, name: `restart_${id}`, input: { token: id } })) });
let modelCalls = 0, active, sid = config.sid, entered;
const reached = new Promise(resolve => { entered = resolve; });
const ledger = event => appendFileSync(join(config.dir, 'ledger.jsonl'), JSON.stringify({ generation: config.generation, ...event }) + '\n');
function hold(signal) { return new Promise(resolve => { if (signal?.aborted) return resolve(); signal?.addEventListener('abort', resolve, { once: true }); }); }
const originalTimer = globalThis.setTimeout;
if (config.generation === 1 && config.phase === 'retry') globalThis.setTimeout = (fn, delay, ...args) => {
  const timer = originalTimer(fn, delay, ...args);
  if (delay === 400) entered('retry-timer-registered');
  return timer;
};
const runtime = new RawAgentRuntime({ repoRoot: join(config.dir, 'repo'), stateDir: join(config.dir, 'state'), maxParallelToolCalls: 1,
  modelAdapter: { name: 'restart-controlled', summarizeMessages: async () => '', completeText: async () => '{"met":true,"reason":"probe"}',
    async runTurn(input) {
      modelCalls++;
      ledger({ kind: 'model', call: modelCalls, parts: input.messages.flatMap(m => m.parts ?? []).filter(p => ['tool_call', 'tool_result'].includes(p.type)).map(p => ({ type: p.type, id: p.toolCallId, ok: p.ok, content: p.content })) });
      if (config.generation !== 1) return text();
      if (config.phase === 'model' || config.phase === 'terminal-cancelled') { entered('model-entered'); await hold(input.signal); return text(); }
      if (config.phase === 'retry') { if (modelCalls === 1) throw new Error('controlled retryable error'); return text(); }
      if (config.phase === 'terminal-failed') throw new Error('controlled persistent error');
      if (config.phase === 'tool') return tools(['b']);
      if (config.phase === 'partial-tools') return tools([modelCalls === 1 ? 'a' : 'b']);
      if (config.phase.startsWith('approval') && modelCalls === 1) return tools(config.phase === 'approval-one' ? ['a'] : ['a', 'b']);
      return text();
    }
  }, extraTools: ['a', 'b'].map(id => ({ name: `restart_${id}`, description: 'Hermetic restart probe', inputSchema: { type: 'object' }, approvalMode: config.phase.startsWith('approval') ? 'always' : 'never', sideEffectLevel: 'none',
    async execute(ctx) {
      ledger({ kind: 'tool', id });
      if (config.generation === 1 && (config.phase === 'tool' || config.phase === 'partial-tools') && id === 'b') { entered('tool-effect-before-result'); await hold(ctx.abortSignal); }
      return { ok: true, content: `result-${id}` };
    }
  })) });
function snapshot() {
  const s = runtime.getSession(sid);
  return { sid, status: s.status, outcome: s.metadata?.outcome ?? null, interrupt: s.metadata?.interrupt ?? null, writer: s.activeWriterRunId ?? null,
    approvals: runtime.listApprovals().filter(a => a.sessionId === sid).sort((a,b) => a.toolName.localeCompare(b.toolName)).map(a => ({ id: a.id, tool: a.toolName, status: a.status, args: a.args })),
    messages: runtime.getSessionMessages(sid).map(m => ({ role: m.role, parts: m.parts })),
    ledger: (() => { try { return readFileSync(join(config.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } })() };
}
function run() { active = runtime.runSession(sid); active.catch(() => {}); return active; }
async function shutdown() { try { await runtime.destroy(); process.exit(0); } catch (e) { console.error(e); process.exit(2); } }
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
process.on('message', async ({ id, command, args }) => {
  try {
    let value;
    if (command === 'prepare') {
      const input = { title: 'restart verification', message: 'local controlled probe', background: false };
      sid = config.mode === 'task' ? runtime.createTaskSession(input).session.id : runtime.createChatSession(input).id;
      run();
      if (['model', 'tool', 'partial-tools', 'retry', 'terminal-cancelled'].includes(config.phase)) { value = await reached; if (config.phase === 'terminal-cancelled') { runtime.cancelSession(sid); await active; } }
      else await active.catch(error => { if(config.phase !== 'terminal-failed') throw error; });
      value = { stage: value ?? 'settled', ...snapshot() };
    } else if (command === 'snapshot') value = snapshot();
    else if (command === 'decide') { for (const [index, decision] of args) await runtime.approve(runtime.listApprovals().filter(a => a.sessionId === sid).sort((a,b) => a.toolName.localeCompare(b.toolName))[index].id, decision); value = snapshot(); }
    else if (command === 'cancel') { runtime.cancelSession(sid); if (active) await active.catch(() => {}); value = snapshot(); }
    else if (command === 'resume') { await run(); value = snapshot(); }
    else if (command === 'fresh') { runtime.sendUserMessage(sid, 'new explicitly requested run'); await run(); value = snapshot(); }
    else if (command === 'shutdown') { await shutdown(); return; }
    else throw new Error('Unknown probe command');
    process.send?.({ id, value });
  } catch (error) { process.send?.({ id, error: error.stack }); }
});
process.send?.({ ready: true, pid: process.pid });
