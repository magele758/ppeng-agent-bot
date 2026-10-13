/** One isolated trial of the real RawAgentRuntime. Input/output files are owned by compare.mjs. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, finalAssistantOutput } from './quality.mjs';

const [inputFile, outputFile] = process.argv.slice(2);
const { task, variant, model, limits, workspace, simulation, trial } = JSON.parse(readFileSync(inputFile, 'utf8'));
const outcome = { output: '', status: 'error', state: {}, toolCalls: [], promptShapes: [], modelCalls: 0,
  tokens: null, invariantsOk: false, infrastructureError: false, modelErrors: [] };
const started = Date.now();
const secret = process.env[model.apiKeyEnv ?? 'RAW_AGENT_API_KEY'];
const safeError = error => String(error?.message ?? error).replaceAll(secret || '\0', '[REDACTED]').slice(0, 1000);

try {
  const core = await import(pathToFileURL(join(variant.repoRoot, 'packages/core/dist/exports/public.js')).href);
  const stateDir = join(workspace, 'state'); mkdirSync(stateDir, { recursive: true });
  const repoRoot = join(workspace, 'repo'); mkdirSync(repoRoot, { recursive: true });
  const attempts = new Map();
  const tools = [
    { name: 'lookup_record', description: 'Read one fixture record by exact key. Returns not_found when absent; transient errors may be retried.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      approvalMode: 'never', sideEffectLevel: 'none',
      execute: async (_ctx, input) => {
        const key = String(input.key), attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
        let result;
        if (attempt <= (task.transientFailures?.[key] ?? 0)) result = { ok: false, content: 'temporary failure; retry is safe' };
        else if (!Object.hasOwn(task.records ?? {}, key)) result = { ok: false, content: 'not_found' };
        else result = { ok: true, content: JSON.stringify(task.records[key]) };
        return result;
      } },
    { name: 'save_result', description: 'Save the task result as a JSON value under a key. This is the only writable state; saving is immediately observable.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'], additionalProperties: false },
      approvalMode: 'never', sideEffectLevel: 'workspace',
      execute: async (_ctx, input) => {
        if (typeof input.key !== 'string' || !Object.hasOwn(input, 'value') || ['__proto__', 'constructor', 'prototype'].includes(input.key)) {
          return { ok: false, content: 'invalid input' };
        }
        outcome.state[input.key] = input.value;
        return { ok: true, content: 'saved' };
      } }
  ];
  let scriptIndex = 0, usageComplete = true, tokens = 0;
  let previousSessionId;
  let adapter;
  if (simulation) {
    adapter = { name: 'scripted-verification-only', async runTurn(input) {
      const entry = task.script?.[scriptIndex++];
      if (!entry) throw new Error('simulation script exhausted');
      if (entry.refFromLastSearch) {
        const result = input.messages.flatMap(m => m.parts).findLast(p => p.type === 'tool_result');
        const parsed = JSON.parse(typeof result?.content === 'string' ? result.content : 'null');
        const match = parsed?.matches?.find(row => row.sessionId === previousSessionId) ?? parsed?.matches?.[0];
        if (!match?.ref) throw new Error('simulation search produced no source reference');
        entry.input = { ref: match.ref };
      }
      return {
        stopReason: entry.tool ? 'tool_use' : 'end', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        assistantParts: entry.tool
          ? [{ type: 'tool_call', toolCallId: `fixture-${scriptIndex}`, name: entry.tool, input: entry.input }]
          : [{ type: 'text', text: variant.simulationFault === 'wrong-answer' ? 'INTENTIONAL_REGRESSION' : entry.text }]
      };
    }, async summarizeMessages() { return 'fixture summary'; } };
  } else {
    const key = process.env[model.apiKeyEnv ?? 'RAW_AGENT_API_KEY'];
    const baseUrl = model.baseUrl ?? process.env[model.baseUrlEnv ?? 'RAW_AGENT_BASE_URL'];
    const name = model.name ?? process.env[model.nameEnv ?? 'RAW_AGENT_MODEL_NAME'];
    if (!key || !baseUrl || !name) throw new Error('live eval requires explicit model name, base URL and API key');
    if (!['openai-compatible', 'anthropic-compatible'].includes(model.provider)) throw new Error('live eval cannot use heuristic/scripted providers');
    const endpoint = new URL(baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid model base URL');
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      // Prevent a fixture/prompt from reaching arbitrary networks through optional runtime hooks.
      if (new URL(url).origin !== endpoint.origin) throw new Error('eval network request outside configured model origin');
      if (++networkCalls > limits.maxModelCalls) throw new Error('model call budget exhausted');
      const body = JSON.parse(String(options.body));
      body.temperature = model.temperature ?? 0;
      if (String(url).includes('/responses')) body.max_output_tokens = limits.maxOutputTokens;
      else body.max_tokens = limits.maxOutputTokens;
      try {
        const response = await originalFetch(url, { ...options, body: JSON.stringify(body), redirect: 'error',
          signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(limits.timeoutMs)]) });
        if ([401, 403, 429].includes(response.status) || response.status >= 500) outcome.infrastructureError = true;
        return response;
      } catch (error) { outcome.infrastructureError = true; throw error; }
    };
    adapter = core.createModelAdapterFromEnv({
      RAW_AGENT_MODEL_PROVIDER: model.provider, RAW_AGENT_MODEL_NAME: name,
      RAW_AGENT_API_KEY: key, RAW_AGENT_BASE_URL: baseUrl,
      RAW_AGENT_OPENAI_HTTP_KIND: model.httpKind ?? 'chat', RAW_AGENT_USE_JSON_MODE: '0'
    });
    outcome.model = { provider: model.provider, name, endpointHash: hash(baseUrl), temperature: model.temperature ?? 0, maxOutputTokens: limits.maxOutputTokens };
  }
  async function turn(input, onStream) {
    if (++outcome.modelCalls > limits.maxModelCalls) throw new Error('model call budget exhausted');
    const systemPrompt = input.systemPrompt + (variant.systemAppendix ? `\n\n${variant.systemAppendix}` : '');
    const inputChars = systemPrompt.length + JSON.stringify(input.messages).length;
    if (inputChars > limits.maxInputChars) throw new Error('model input budget exhausted');
    outcome.promptShapes.push({ systemHash: hash(systemPrompt), systemChars: systemPrompt.length, inputChars, tools: input.tools.map(t => t.name) });
    const actual = { ...input, systemPrompt };
    let result;
    try {
      result = onStream && typeof adapter.runTurnStream === 'function'
        ? await adapter.runTurnStream(actual, onStream) : await adapter.runTurn(actual);
    } catch (error) {
      usageComplete = false;
      outcome.modelErrors.push(safeError(error));
      throw error;
    }
    if (result.usage && Number.isFinite(result.usage.inputTokens) && Number.isFinite(result.usage.outputTokens)) tokens += result.usage.inputTokens + result.usage.outputTokens;
    else usageComplete = false;
    return result;
  }
  const measured = { name: adapter.name,
    runTurn: input => turn(input), runTurnStream: (input, stream) => turn(input, stream),
    async summarizeMessages(input) { usageComplete = false; return adapter.summarizeMessages(input); }
  };
  if (adapter.completeText) measured.completeText = async input => { usageComplete = false; return adapter.completeText(input); };
  const general = core.builtinAgents.find(a => a.id === 'general');
  const runtime = new core.RawAgentRuntime({ repoRoot, stateDir, modelAdapter: measured,
    agents: [{ ...general, allowedTools: task.contextSeed ? ['history_search', 'history_read', 'retrieve_tool_result'] : tools.map(t => t.name) }],
    ...(task.contextSeed ? {} : { tools }) });
  outcome.savedSettings = {};
  for (const [key, value] of Object.entries(variant.daemonControl ?? {})) {
    runtime.store.setDaemonControl(key, value);
    outcome.savedSettings[key] = runtime.store.getDaemonControl(key);
  }
  const identity = task.contextSeed ? { userId: 'context-eval-user', tenantId: 'context-eval-tenant',
    ...(task.contextSeed.mode === 'bot' ? { canonicalBotChat: true, botId: 'context-eval-bot' } : {}) } : {};
  if (task.contextSeed?.previous) {
    const previous = runtime.createChatSession({ title: 'Previous deployment decision', message: task.contextSeed.previous,
      agentId: 'general', metadata: identity });
    previousSessionId = previous.id;
    runtime.store.appendMessage(previous.id, 'assistant', [{ type: 'text', text: 'Decision recorded.' }]);
  }
  const session = runtime.createChatSession({ title: `quality-${task.id}`, message: task.turns[0], agentId: 'general',
    metadata: { allowedSkillNames: [], ...identity } });
  for (let i = 0; i < task.turns.length; i++) {
    if (task.contextSeed && i === task.turns.length - 1) {
      outcome.contextEvidence = { seededMessages: 0, compactRounds: [] };
      for (let round = 0; round < 2; round++) {
        for (const row of task.contextSeed.history) {
          runtime.store.appendMessage(session.id, row.role, [{ type: 'text', text: row.text + ' Archived diagnostic line; routine check succeeded.'.repeat(row.paddingRepeats ?? 0) }]);
          outcome.contextEvidence.seededMessages++;
        }
        if (task.contextSeed.compact) {
          // Product's existing forced-compaction entry, not a synthetic summary replacement.
          const compact = await runtime.compactCanonicalSession(session.id);
          outcome.contextEvidence.compactRounds.push(compact);
          if (!compact.replaced) throw new Error('context fixture did not compact; semantic evaluation invalid');
        }
      }
    }
    if (i) runtime.sendUserMessage(session.id, task.turns[i]);
    await runtime.runSession(session.id, { onModelStreamChunk: () => {} });
  }
  outcome.status = runtime.getSession(session.id).status;
  // The general-purpose summary getter also includes reasoning. Preserve the
  // folded conversation view, but grade only user-facing final-answer text.
  outcome.output = finalAssistantOutput(runtime.store.foldMessages(session.id));
  const transcript = runtime.getSessionMessages(session.id);
  core.assertTranscriptInvariants(transcript);
  outcome.invariantsOk = true;
  // The transcript includes pre-execution rejections as well as executed calls.
  // Count each attempt once; the paired result determines execution success.
  const parts = transcript.flatMap(m => m.parts);
  const results = new Map(parts.filter(p => p.type === 'tool_result').map(p => [p.toolCallId, p]));
  outcome.toolCalls = parts.filter(p => p.type === 'tool_call').map(part => ({
    toolCallId: part.toolCallId, name: part.name, input: part.input,
    ok: results.get(part.toolCallId)?.ok === true
  }));
  if (task.contextSeed?.previous) {
    outcome.contextEvidence.historySourceVerified = parts.filter(p => p.type === 'tool_call' && p.name === 'history_read').some(call => {
      const result = results.get(call.toolCallId);
      if (result?.ok !== true) return false;
      try {
        const source = JSON.parse(result.content);
        return source.sessionId === previousSessionId && typeof source.text === 'string' && source.text.includes(task.expected.exact);
      } catch { return false; }
    });
    if (!outcome.contextEvidence.historySourceVerified) outcome.error = 'cross-session answer lacks a successful read of the original evidence';
  }
  outcome.tokens = usageComplete ? tokens : null;
  outcome.transcript = transcript;
} catch (error) {
  outcome.error = safeError(error);
  outcome.infrastructureError ||= /fetch failed|ECONN|HTTP (429|5\d\d)|requires explicit|Cannot find module|outside configured model origin/.test(outcome.error);
} finally {
  outcome.durationMs = Date.now() - started;
  outcome.trial = trial;
  writeFileSync(outputFile, JSON.stringify(outcome, null, 2), { mode: 0o600 });
}
// Runtime may keep background timers. All state lives in the parent-owned temp workspace.
process.exit(0);
