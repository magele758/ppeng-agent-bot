import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output, exit } from 'node:process';
import { createDaemonClient, type ChatMessage, type ModelStreamChunk } from '@ppeng/daemon-client';

const client = createDaemonClient();

async function request<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
  return client.request<T>(pathname, init);
}

function printModelChunk(chunk: ModelStreamChunk): void {
  if (chunk.type === 'text_delta' || chunk.type === 'reasoning_delta') {
    process.stdout.write(chunk.text);
  } else if (chunk.type === 'stream_reset') {
    // Already-printed output cannot be taken back; mark where the answer restarts.
    process.stdout.write(`\n--- model ${chunk.reason}: answer restarts ---\n`);
  }
}

/** POST /api/sessions/:id/stream，逐块打印文本增量；返回结束时的 session 状态（用于 waiting_approval 提示）。 */
async function streamTurn(sessionId: string, message: string): Promise<{ status?: string } | undefined> {
  let session: { status?: string } | undefined;
  let streamError: string | undefined;
  await client.stream(
    `/api/sessions/${sessionId}/stream`,
    { method: 'POST', body: JSON.stringify({ message }) },
    (event, payload) => {
      if (event === 'model') {
        printModelChunk(payload as ModelStreamChunk);
        return;
      }
      if (event === 'result') {
        session = (payload as { session?: { status?: string } }).session;
        return;
      }
      if (event === 'error') {
        streamError = (payload as { message?: string }).message ?? 'stream error';
      }
    }
  );
  process.stdout.write('\n');
  if (streamError) throw new Error(streamError);
  return session;
}

function usage(): void {
  console.log(`raw-agent CLI

Commands:
  chat <message>
  bot ls
  bot create <name>
  bot show <botId>
  bot open <botId>             print this bot's chat session id
  bot send <botId> <message>   open that chat and stream one reply
  bot goals <botId>            list goals on that bot chat
  send <sessionId> <message>
  attach <sessionId> <message>   same as send (attach-friendly alias)
  stream <sessionId> <message>   POST /api/sessions/:id/stream (SSE text)
  research create <query...>
  research run <taskId>
  research show <taskId>
  swarm create <goal...>
  swarm start <runId>
  swarm show <runId>
  doctor                     local env/plugins/gateway/sandbox self-check
  session permission <id> [mode|elevate|demote]
  session ls
  session show <sessionId>
  session new [title]            create idle chat session (no auto-run); prints id
  session repl <sessionId> [--no-stream]   interactive one line = one user message, streamed by default (quit|exit to stop)
  session team [sessionId]     JSON team tree: all sessions, or subtree for sessionId
  team spawn <name> <role> <prompt...>   POST /api/teams (teammate session)
  task create <title> [description]
  task ls
  task show <taskId>
  approve <approvalId> <approve|reject>
  agent ls
  workspace ls
  scheduler run
  self-heal start [json]   optional policy JSON, e.g. '{"testPreset":"unit","autoMerge":false}'
  self-heal status
  self-heal runs [limit]
  self-heal show <runId>
  self-heal logs <runId>
  self-heal stop <runId>
  self-heal resume <runId>
  daemon restart-status
  daemon restart-ack`);
}

function printMessages(messages: ChatMessage[]) {
  for (const message of messages) {
    const text = message.parts
      .map((part) => {
        if (part.type === 'text') return part.text ?? '';
        if (part.type === 'tool_call') return `[tool_call ${part.name}]`;
        if (part.type === 'tool_result') return `[tool_result ${part.name}] ${part.content ?? ''}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    console.log(`${message.role}: ${text}`);
  }
}

function requireArg(value: string | undefined, usageText: string): string {
  if (!value) throw new Error(usageText);
  return value;
}

function joinedName(parts: string[]): string {
  return parts.join(' ').trim();
}

/** The typed command is the caller's confirmation, which bypass requires. */
function permissionBody(action: string): { shift?: string; mode?: string; confirmBypass: true } {
  if (action === 'elevate' || action === 'demote') return { shift: action, confirmBypass: true };
  return { mode: action, confirmBypass: true };
}

function formatBotRow(bot: { id: string; name: string }): string {
  return `${bot.id}  ${bot.name}`;
}

function botLines(bots: Array<{ id: string; name: string }>): string {
  return bots.map(formatBotRow).join('\n');
}

async function listBots(): Promise<void> {
  const data = await request<{ bots?: Array<{ id: string; name: string }> }>('/api/bots');
  const text = botLines(data.bots ?? []);
  console.log(text.length === 0 ? '(no bots)' : text);
}

async function createBot(rest: string[]): Promise<void> {
  const name = requireArg(joinedName(rest), 'Usage: bot create <name>');
  const data = await request<{ bot?: { id?: string; name?: string } }>('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  const id = data.bot?.id;
  if (!id) throw new Error('bot create did not return an id');
  console.log(`${id}  ${data.bot?.name ?? ''}`);
}

async function showBot(rest: string[]): Promise<void> {
  const botId = requireArg(rest[0], 'Usage: bot show <botId>');
  const data = await request<{ bot?: { id: string; name: string } }>(`/api/bots/${encodeURIComponent(botId)}`);
  if (!data.bot) throw new Error('bot not found');
  console.log(formatBotRow(data.bot));
}

/** Goals live on the bot chat, so the list request needs the session from open. */
async function openBotSession(botId: string): Promise<string> {
  const opened = await request<{ session?: { id?: string } }>(`/api/bots/${encodeURIComponent(botId)}/open`, {
    method: 'POST'
  });
  const sessionId = opened.session?.id;
  if (!sessionId) throw new Error('bot open did not return a session');
  return sessionId;
}

async function openBot(rest: string[]): Promise<void> {
  const botId = requireArg(rest[0], 'Usage: bot open <botId>');
  console.log(await openBotSession(botId));
}

async function sendBot(rest: string[]): Promise<void> {
  const botId = requireArg(rest[0], 'Usage: bot send <botId> <message>');
  const message = requireArg(joinedName(rest.slice(1)), 'Usage: bot send <botId> <message>');
  await streamTurn(await openBotSession(botId), message);
}

function formatGoalRow(goal: { id: string; status: string; title: string }): string {
  return `${goal.id}  ${goal.status}  ${goal.title}`;
}

function goalLines(goals: Array<{ id: string; status: string; title: string }>): string {
  return goals.map(formatGoalRow).join('\n');
}

async function printBotGoals(rest: string[]): Promise<void> {
  const botId = requireArg(rest[0], 'Usage: bot goals <botId>');
  const sessionId = await openBotSession(botId);
  const data = await request<{ goals?: Array<{ id: string; title: string; status: string }> }>(
    `/api/bots/${encodeURIComponent(botId)}/goals?sessionId=${encodeURIComponent(sessionId)}`
  );
  const text = goalLines(data.goals ?? []);
  console.log(text.length === 0 ? '(no goals)' : text);
}

async function runBotCommand(subcommand: string | undefined, rest: string[]): Promise<void> {
  const handlers: Record<string, (args: string[]) => Promise<void>> = {
    ls: () => listBots(),
    create: createBot,
    show: showBot,
    open: openBot,
    send: sendBot,
    goals: printBotGoals
  };
  const handler = subcommand ? handlers[subcommand] : undefined;
  if (!handler) {
    throw new Error(
      'Usage: bot ls | bot create <name> | bot show <botId> | bot open <botId> | bot send <botId> <message> | bot goals <botId>'
    );
  }
  await handler(rest);
}

type CliHandler = (subcommand: string | undefined, rest: string[]) => Promise<void>;

async function runSubcommand(
  handlers: Record<string, (args: string[]) => Promise<void>>,
  subcommand: string | undefined,
  rest: string[]
): Promise<boolean> {
  const handler = subcommand ? handlers[subcommand] : undefined;
  if (!handler) return false;
  await handler(rest);
  return true;
}

async function runChat(subcommand: string | undefined, rest: string[]): Promise<void> {
  const message = [subcommand, ...rest].filter(Boolean).join(' ');
  const result = (await request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message })
  })) as {
    session: { id: string };
    latestAssistant?: string;
  };
  console.log(`${result.session.id}`);
  if (result.latestAssistant) {
    console.log(result.latestAssistant);
  }
}

async function runSessionMessage(command: string, subcommand: string | undefined, rest: string[]): Promise<void> {
  const sessionId = subcommand;
  const message = rest.join(' ');
  if (!sessionId || !message) {
    throw new Error(`Usage: ${command} <sessionId> <message>`);
  }
  const result = (await request(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message })
  })) as {
    latestAssistant?: string;
    session?: { status?: string };
  };
  await printMessageResult(result);
}

function printAssistant(result: { latestAssistant?: string }): void {
  if (result.latestAssistant) console.log(result.latestAssistant);
}

async function printMessageResult(result: { latestAssistant?: string; session?: { status?: string } }): Promise<void> {
  if (result.session?.status === 'waiting_approval') await printPendingApprovals();
  printAssistant(result);
}

async function printPendingApprovals(): Promise<void> {
  console.error('waiting_approval — use: approve <approvalId> approve|reject');
  const approvals = await request<{ approvals?: Array<{ id: string; toolName: string }> }>('/api/approvals');
  for (const a of approvals.approvals ?? []) console.error(`  pending ${a.id} ${a.toolName}`);
}

async function runStream(subcommand: string | undefined, rest: string[]): Promise<void> {
  const sessionId = subcommand;
  const message = rest.join(' ');
  if (!sessionId || !message) {
    throw new Error('Usage: stream <sessionId> <message>');
  }
  await streamTurn(sessionId, message);
}

async function createResearch(rest: string[]): Promise<void> {
  const query = rest.join(' ').trim();
  if (!query) throw new Error('Usage: research create <query...>');
  const data = (await request('/api/research/tasks', {
    method: 'POST',
    body: JSON.stringify({ query })
  })) as { task: { id: string; status: string } };
  console.log(`${data.task.id} ${data.task.status}`);
}

async function runResearchTask(rest: string[]): Promise<void> {
  const taskId = rest[0];
  if (!taskId) throw new Error('Usage: research run <taskId>');
  const data = await request(`/api/research/tasks/${taskId}/run`, { method: 'POST' });
  console.log(JSON.stringify(data, null, 2));
}

async function showResearch(rest: string[]): Promise<void> {
  const taskId = rest[0];
  if (!taskId) throw new Error('Usage: research show <taskId>');
  const data = await request(`/api/research/tasks/${taskId}`);
  console.log(JSON.stringify(data, null, 2));
}

async function runResearch(subcommand: string | undefined, rest: string[]): Promise<void> {
  const handled = await runSubcommand(
    { create: createResearch, run: runResearchTask, show: showResearch },
    subcommand,
    rest
  );
  if (!handled) usage();
}

async function createSwarm(rest: string[]): Promise<void> {
  const goal = rest.join(' ').trim();
  if (!goal) throw new Error('Usage: swarm create <goal...>');
  const data = (await request('/api/swarm/runs', {
    method: 'POST',
    body: JSON.stringify({ goal, strategy: 'pipeline' })
  })) as { run: { id: string; status: string } };
  console.log(`${data.run.id} ${data.run.status}`);
}

async function startSwarm(rest: string[]): Promise<void> {
  const runId = rest[0];
  if (!runId) throw new Error('Usage: swarm start <runId>');
  const data = await request(`/api/swarm/runs/${runId}/start`, {
    method: 'POST',
    body: JSON.stringify({ tasks: [{ title: 'Implement', requiredRole: 'implementer' }] })
  });
  console.log(JSON.stringify(data, null, 2));
}

async function showSwarm(rest: string[]): Promise<void> {
  const runId = rest[0];
  if (!runId) throw new Error('Usage: swarm show <runId>');
  const data = await request(`/api/swarm/runs/${runId}`);
  console.log(JSON.stringify(data, null, 2));
}

async function runSwarm(subcommand: string | undefined, rest: string[]): Promise<void> {
  const handled = await runSubcommand(
    { create: createSwarm, start: startSwarm, show: showSwarm },
    subcommand,
    rest
  );
  if (!handled) usage();
}

async function runTeam(subcommand: string | undefined, rest: string[]): Promise<void> {
  if (subcommand !== 'spawn') {
    usage();
    return;
  }
  const name = rest[0];
  const role = rest[1];
  const prompt = rest.slice(2).join(' ');
  if (!name || !role || !prompt) {
    throw new Error('Usage: team spawn <name> <role> <prompt...>');
  }
  const result = (await request('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name, role, prompt })
  })) as {
    session: { id: string };
    latestAssistant?: string;
  };
  console.log(result.session.id);
  printAssistant(result);
}

async function createSession(rest: string[]): Promise<void> {
  const title = rest.length > 0 ? rest.join(' ') : 'CLI Session';
  const result = (await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, autoRun: false })
  })) as { session: { id: string } };
  console.log(result.session.id);
}

async function replSession(rest: string[]): Promise<void> {
  const sessionId = rest[0];
  const noStream = rest.includes('--no-stream');
  if (!sessionId) {
    throw new Error('Usage: session repl <sessionId> [--no-stream]');
  }
  const rl = readline.createInterface({ input, output, terminal: true });
  console.error(`repl on ${sessionId} (quit or exit to stop)`);
  try {
    for (;;) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (['quit', 'exit'].includes(line)) break;
      await sendReplMessage(sessionId, line, noStream);
    }
  } finally {
    rl.close();
  }
}

async function sendReplMessage(sessionId: string, line: string, noStream: boolean): Promise<void> {
  if (noStream) {
    printAssistant(await request<{ latestAssistant?: string }>(`/api/sessions/${sessionId}/messages`, {
      method: 'POST', body: JSON.stringify({ message: line })
    }));
    return;
  }
  const session = await streamTurn(sessionId, line);
  if (session?.status === 'waiting_approval') console.error('waiting_approval — use: approve <approvalId> approve|reject');
}

async function showSessionTeam(rest: string[]): Promise<void> {
  const sessionId = rest[0];
  const data = await request(sessionId ? `/api/sessions/${sessionId}/team` : '/api/sessions/team-overview');
  console.log(JSON.stringify(data, null, 2));
}

async function listSessions(): Promise<void> {
  const result = (await request('/api/sessions')) as {
    sessions: Array<{ id: string; mode: string; status: string; agentId: string; title: string }>;
  };
  for (const session of result.sessions) {
    console.log(`${session.id}  ${session.mode.padEnd(9)}  ${session.status.padEnd(18)}  ${session.agentId.padEnd(12)}  ${session.title}`);
  }
}

async function showSession(rest: string[]): Promise<void> {
  const sessionId = rest[0];
  if (!sessionId) {
    throw new Error('Missing session id');
  }
  const result = (await request(`/api/sessions/${sessionId}`)) as {
    session: { id: string; mode: string; status: string; title: string; agentId: string };
    latestAssistant?: string;
    messages: Array<{ role: string; parts: Array<{ type: string; text?: string; content?: string; name?: string }> }>;
  };
  console.log(`${result.session.id} ${result.session.mode} ${result.session.status} ${result.session.agentId}`);
  console.log(result.session.title);
  if (result.latestAssistant) {
    console.log(`latest: ${result.latestAssistant}`);
  }
  console.log('');
  printMessages(result.messages);
}

async function changeSessionPermission(rest: string[]): Promise<void> {
  const sessionId = rest[0];
  const action = rest[1];
  if (!sessionId) throw new Error('Usage: session permission <sessionId> [mode|elevate|demote]');
  if (!action) {
    const data = await request(`/api/sessions/${sessionId}/permission`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const body = permissionBody(action);
  const data = await request(`/api/sessions/${sessionId}/permission`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  console.log(JSON.stringify(data, null, 2));
}

async function runSession(subcommand: string | undefined, rest: string[]): Promise<void> {
  const handled = await runSubcommand(
    {
      new: createSession,
      repl: replSession,
      team: showSessionTeam,
      ls: listSessions,
      show: showSession,
      permission: changeSessionPermission
    },
    subcommand,
    rest
  );
  if (!handled) usage();
}

async function createTask(rest: string[]): Promise<void> {
  const [title, ...descriptionParts] = rest;
  if (!title) {
    throw new Error('Missing task title');
  }
  const result = (await request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      description: descriptionParts.join(' ')
    })
  })) as {
    task: { id: string; status: string; title: string };
    latestAssistant?: string;
  };
  console.log(`${result.task.id} ${result.task.status} ${result.task.title}`);
  if (result.latestAssistant) {
    console.log(result.latestAssistant);
  }
}

async function listTasks(): Promise<void> {
  const result = (await request('/api/tasks')) as {
    tasks: Array<{ id: string; status: string; ownerAgentId?: string; title: string }>;
  };
  for (const task of result.tasks) {
    console.log(`${task.id}  ${task.status.padEnd(12)}  ${(task.ownerAgentId ?? '-').padEnd(12)}  ${task.title}`);
  }
}

async function showTask(rest: string[]): Promise<void> {
  const taskId = rest[0];
  if (!taskId) {
    throw new Error('Missing task id');
  }
  const result = (await request(`/api/tasks/${taskId}`)) as {
    task: { id: string; status: string; title: string; description: string };
    events: Array<{ createdAt: string; kind: string; actor: string }>;
  };
  console.log(`${result.task.id} ${result.task.status}`);
  console.log(result.task.title);
  if (result.task.description) {
    console.log(result.task.description);
  }
  console.log('');
  for (const event of result.events) {
    console.log(`${event.createdAt}  ${event.kind}  ${event.actor}`);
  }
}

async function runTask(subcommand: string | undefined, rest: string[]): Promise<void> {
  const handled = await runSubcommand(
    { create: createTask, ls: listTasks, show: showTask },
    subcommand,
    rest
  );
  if (!handled) usage();
}

async function runApprove(subcommand: string | undefined, rest: string[]): Promise<void> {
  const approvalId = subcommand;
  const action = rest[0];
  if (action !== 'approve' && action !== 'reject') throw new Error('Expected explicit approve or reject decision');
  if (!approvalId) {
    throw new Error('Missing approval id');
  }
  const result = (await request(`/api/approvals/${approvalId}/${action}`, {
    method: 'POST'
  })) as {
    approval: { id: string; status: string };
  };
  console.log(`${result.approval.id} ${result.approval.status}`);
}

async function runAgent(subcommand: string | undefined): Promise<void> {
  if (subcommand !== 'ls') {
    usage();
    return;
  }
  const result = (await request('/api/agents')) as {
    agents: Array<{ id: string; role: string; capabilities: string[] }>;
  };
  for (const agent of result.agents) {
    console.log(`${agent.id}  ${agent.role}  ${agent.capabilities.join(', ')}`);
  }
}

async function runWorkspace(subcommand: string | undefined): Promise<void> {
  if (subcommand !== 'ls') {
    usage();
    return;
  }
  const result = (await request('/api/workspaces')) as {
    workspaces: Array<{ id: string; taskId: string; mode: string; rootPath: string }>;
  };
  for (const workspace of result.workspaces) {
    console.log(`${workspace.id}  ${workspace.taskId}  ${workspace.mode}  ${workspace.rootPath}`);
  }
}

async function runScheduler(subcommand: string | undefined): Promise<void> {
  if (subcommand !== 'run') {
    usage();
    return;
  }
  await request('/api/scheduler/run', {
    method: 'POST'
  });
  console.log('scheduler cycle completed');
}

async function startSelfHeal(rest: string[]): Promise<void> {
  const raw = rest.join(' ').trim();
  let body: Record<string, unknown> = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('Invalid JSON for self-heal policy (see: self-heal start {"testPreset":"unit"})');
    }
  }
  const payload = body.policy !== undefined ? body : { policy: body };
  const run = (await request('/api/self-heal/start', {
    method: 'POST',
    body: JSON.stringify(payload)
  })) as { run: { id: string; status: string } };
  console.log(`${run.run.id} ${run.run.status}`);
}

async function printSelfHealStatus(): Promise<void> {
  const data = (await request('/api/self-heal/status')) as { active: Array<{ id: string; status: string }> };
  if (data.active.length === 0) {
    console.log('(no active self-heal runs)');
    return;
  }
  for (const r of data.active) {
    console.log(`${r.id}  ${r.status}`);
  }
}

async function listSelfHealRuns(rest: string[]): Promise<void> {
  const limit = rest[0] ? Number(rest[0]) : 10;
  const data = (await request(`/api/self-heal/runs?limit=${Number.isFinite(limit) ? limit : 10}`)) as {
    runs: Array<{ id: string; status: string; updatedAt?: string }>;
  };
  for (const r of data.runs) {
    console.log(`${r.id}  ${r.status}`);
  }
}

async function showSelfHealRun(rest: string[]): Promise<void> {
  const runId = rest[0];
  if (!runId) {
    usage();
    return;
  }
  const data = (await request(`/api/self-heal/runs/${runId}`)) as { run: Record<string, unknown> };
  console.log(JSON.stringify(data.run, null, 2));
}

async function printSelfHealLogs(rest: string[]): Promise<void> {
  const runId = rest[0];
  if (!runId) {
    usage();
    return;
  }
  const data = (await request(`/api/self-heal/runs/${runId}/events`)) as {
    events: Array<{ kind: string; createdAt: string; payload: unknown }>;
  };
  for (const e of data.events) {
    console.log(`${e.createdAt}  ${e.kind}  ${JSON.stringify(e.payload)}`);
  }
}

async function stopSelfHealRun(rest: string[]): Promise<void> {
  const runId = rest[0];
  if (!runId) {
    usage();
    return;
  }
  const data = (await request(`/api/self-heal/runs/${runId}/stop`, { method: 'POST' })) as {
    run: { id: string; status: string };
  };
  console.log(`${data.run.id} ${data.run.status}`);
}

async function resumeSelfHealRun(rest: string[]): Promise<void> {
  const runId = rest[0];
  if (!runId) {
    usage();
    return;
  }
  const data = (await request(`/api/self-heal/runs/${runId}/resume`, { method: 'POST' })) as {
    run: { id: string; status: string };
  };
  console.log(`${data.run.id} ${data.run.status}`);
}

async function runSelfHeal(subcommand: string | undefined, rest: string[]): Promise<void> {
  const handled = await runSubcommand(
    {
      start: startSelfHeal,
      status: printSelfHealStatus,
      runs: listSelfHealRuns,
      show: showSelfHealRun,
      logs: printSelfHealLogs,
      stop: stopSelfHealRun,
      resume: resumeSelfHealRun
    },
    subcommand,
    rest
  );
  if (!handled) usage();
}

async function runDoctor(): Promise<void> {
  const data = (await request('/api/doctor')) as {
    ok: boolean;
    summary: { ok: number; warn: number; fail: number };
    checks: Array<{ severity: string; title: string; detail: string; hint?: string }>;
  };
  console.log(
    `doctor ${data.ok ? 'OK' : 'ISSUES'} (${data.summary.ok} ok / ${data.summary.warn} warn / ${data.summary.fail} fail)`
  );
  for (const c of data.checks) {
    console.log(`[${c.severity.toUpperCase()}] ${c.title}: ${c.detail}`);
    if (c.hint) console.log(`       hint: ${c.hint}`);
  }
  if (!data.ok) exit(1);
}

async function runDaemon(subcommand: string | undefined): Promise<void> {
  if (subcommand === 'restart-status') {
    const data = (await request('/api/daemon/restart-request')) as { restartRequest: unknown };
    console.log(JSON.stringify(data.restartRequest, null, 2));
    return;
  }
  if (subcommand === 'restart-ack') {
    await request('/api/daemon/restart-request/ack', { method: 'POST' });
    console.log('acknowledged');
    return;
  }
  usage();
}

const commandHandlers: Record<string, CliHandler> = {
  chat: runChat,
  send: (subcommand, rest) => runSessionMessage('send', subcommand, rest),
  attach: (subcommand, rest) => runSessionMessage('attach', subcommand, rest),
  stream: runStream,
  research: runResearch,
  swarm: runSwarm,
  team: runTeam,
  session: runSession,
  task: runTask,
  approve: runApprove,
  agent: runAgent,
  workspace: runWorkspace,
  scheduler: runScheduler,
  'self-heal': runSelfHeal,
  doctor: runDoctor,
  daemon: runDaemon,
  bot: runBotCommand
};

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command) {
    usage();
    return;
  }
  const handler = commandHandlers[command];
  if (!handler) {
    usage();
    return;
  }
  await handler(subcommand, rest);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
