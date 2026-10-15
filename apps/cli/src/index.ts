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

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);

  if (!command) {
    usage();
    return;
  }

  if (command === 'chat') {
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
    return;
  }

  if (command === 'send' || command === 'attach') {
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
    if (result.session?.status === 'waiting_approval') {
      console.error('waiting_approval — use: approve <approvalId> approve|reject');
      const approvals = (await request('/api/approvals')) as {
        approvals?: Array<{ id: string; toolName: string }>;
      };
      for (const a of approvals.approvals ?? []) {
        console.error(`  pending ${a.id} ${a.toolName}`);
      }
    }
    if (result.latestAssistant) {
      console.log(result.latestAssistant);
    }
    return;
  }

  if (command === 'stream') {
    const sessionId = subcommand;
    const message = rest.join(' ');
    if (!sessionId || !message) {
      throw new Error('Usage: stream <sessionId> <message>');
    }
    await streamTurn(sessionId, message);
    return;
  }

  if (command === 'research' && subcommand === 'create') {
    const query = rest.join(' ').trim();
    if (!query) throw new Error('Usage: research create <query...>');
    const data = (await request('/api/research/tasks', {
      method: 'POST',
      body: JSON.stringify({ query })
    })) as { task: { id: string; status: string } };
    console.log(`${data.task.id} ${data.task.status}`);
    return;
  }
  if (command === 'research' && subcommand === 'run') {
    const taskId = rest[0];
    if (!taskId) throw new Error('Usage: research run <taskId>');
    const data = await request(`/api/research/tasks/${taskId}/run`, { method: 'POST' });
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (command === 'research' && subcommand === 'show') {
    const taskId = rest[0];
    if (!taskId) throw new Error('Usage: research show <taskId>');
    const data = await request(`/api/research/tasks/${taskId}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'swarm' && subcommand === 'create') {
    const goal = rest.join(' ').trim();
    if (!goal) throw new Error('Usage: swarm create <goal...>');
    const data = (await request('/api/swarm/runs', {
      method: 'POST',
      body: JSON.stringify({ goal, strategy: 'pipeline' })
    })) as { run: { id: string; status: string } };
    console.log(`${data.run.id} ${data.run.status}`);
    return;
  }
  if (command === 'swarm' && subcommand === 'start') {
    const runId = rest[0];
    if (!runId) throw new Error('Usage: swarm start <runId>');
    const data = await request(`/api/swarm/runs/${runId}/start`, {
      method: 'POST',
      body: JSON.stringify({ tasks: [{ title: 'Implement', requiredRole: 'implementer' }] })
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (command === 'swarm' && subcommand === 'show') {
    const runId = rest[0];
    if (!runId) throw new Error('Usage: swarm show <runId>');
    const data = await request(`/api/swarm/runs/${runId}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'team' && subcommand === 'spawn') {
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
    if (result.latestAssistant) {
      console.log(result.latestAssistant);
    }
    return;
  }

  if (command === 'session' && subcommand === 'new') {
    const title = rest.length > 0 ? rest.join(' ') : 'CLI Session';
    const result = (await request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, autoRun: false })
    })) as { session: { id: string } };
    console.log(result.session.id);
    return;
  }

  if (command === 'session' && subcommand === 'repl') {
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
        if (line === 'quit' || line === 'exit') break;
        if (noStream) {
          const result = (await request(`/api/sessions/${sessionId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ message: line })
          })) as { latestAssistant?: string };
          if (result.latestAssistant) {
            console.log(result.latestAssistant);
          }
          continue;
        }
        const session = await streamTurn(sessionId, line);
        if (session?.status === 'waiting_approval') {
          console.error('waiting_approval — use: approve <approvalId> approve|reject');
        }
      }
    } finally {
      rl.close();
    }
    return;
  }

  if (command === 'session' && subcommand === 'team') {
    const sessionId = rest[0];
    if (sessionId) {
      const data = await request(`/api/sessions/${sessionId}/team`);
      console.log(JSON.stringify(data, null, 2));
    } else {
      const data = await request('/api/sessions/team-overview');
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (command === 'session' && subcommand === 'ls') {
    const result = (await request('/api/sessions')) as {
      sessions: Array<{ id: string; mode: string; status: string; agentId: string; title: string }>;
    };
    for (const session of result.sessions) {
      console.log(`${session.id}  ${session.mode.padEnd(9)}  ${session.status.padEnd(18)}  ${session.agentId.padEnd(12)}  ${session.title}`);
    }
    return;
  }

  if (command === 'session' && subcommand === 'show') {
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
    return;
  }

  if (command === 'task' && subcommand === 'create') {
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
    return;
  }

  if (command === 'task' && subcommand === 'ls') {
    const result = (await request('/api/tasks')) as {
      tasks: Array<{ id: string; status: string; ownerAgentId?: string; title: string }>;
    };
    for (const task of result.tasks) {
      console.log(`${task.id}  ${task.status.padEnd(12)}  ${(task.ownerAgentId ?? '-').padEnd(12)}  ${task.title}`);
    }
    return;
  }

  if (command === 'task' && subcommand === 'show') {
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
    return;
  }

  if (command === 'approve') {
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
    return;
  }

  if (command === 'agent' && subcommand === 'ls') {
    const result = (await request('/api/agents')) as {
      agents: Array<{ id: string; role: string; capabilities: string[] }>;
    };
    for (const agent of result.agents) {
      console.log(`${agent.id}  ${agent.role}  ${agent.capabilities.join(', ')}`);
    }
    return;
  }

  if (command === 'workspace' && subcommand === 'ls') {
    const result = (await request('/api/workspaces')) as {
      workspaces: Array<{ id: string; taskId: string; mode: string; rootPath: string }>;
    };
    for (const workspace of result.workspaces) {
      console.log(`${workspace.id}  ${workspace.taskId}  ${workspace.mode}  ${workspace.rootPath}`);
    }
    return;
  }

  if (command === 'scheduler' && subcommand === 'run') {
    await request('/api/scheduler/run', {
      method: 'POST'
    });
    console.log('scheduler cycle completed');
    return;
  }

  if (command === 'self-heal') {
    if (subcommand === 'start') {
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
      return;
    }
    if (subcommand === 'status') {
      const data = (await request('/api/self-heal/status')) as { active: Array<{ id: string; status: string }> };
      if (data.active.length === 0) {
        console.log('(no active self-heal runs)');
        return;
      }
      for (const r of data.active) {
        console.log(`${r.id}  ${r.status}`);
      }
      return;
    }
    if (subcommand === 'runs') {
      const limit = rest[0] ? Number(rest[0]) : 10;
      const data = (await request(`/api/self-heal/runs?limit=${Number.isFinite(limit) ? limit : 10}`)) as {
        runs: Array<{ id: string; status: string; updatedAt?: string }>;
      };
      for (const r of data.runs) {
        console.log(`${r.id}  ${r.status}`);
      }
      return;
    }
    if (subcommand === 'show' && rest[0]) {
      const data = (await request(`/api/self-heal/runs/${rest[0]}`)) as { run: Record<string, unknown> };
      console.log(JSON.stringify(data.run, null, 2));
      return;
    }
    if (subcommand === 'logs' && rest[0]) {
      const data = (await request(`/api/self-heal/runs/${rest[0]}/events`)) as {
        events: Array<{ kind: string; createdAt: string; payload: unknown }>;
      };
      for (const e of data.events) {
        console.log(`${e.createdAt}  ${e.kind}  ${JSON.stringify(e.payload)}`);
      }
      return;
    }
    if (subcommand === 'stop' && rest[0]) {
      const data = (await request(`/api/self-heal/runs/${rest[0]}/stop`, { method: 'POST' })) as {
        run: { id: string; status: string };
      };
      console.log(`${data.run.id} ${data.run.status}`);
      return;
    }
    if (subcommand === 'resume' && rest[0]) {
      const data = (await request(`/api/self-heal/runs/${rest[0]}/resume`, { method: 'POST' })) as {
        run: { id: string; status: string };
      };
      console.log(`${data.run.id} ${data.run.status}`);
      return;
    }
    usage();
    return;
  }

  if (command === 'doctor') {
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
    return;
  }

  if (command === 'session' && subcommand === 'permission') {
    const sessionId = rest[0];
    const action = rest[1];
    if (!sessionId) throw new Error('Usage: session permission <sessionId> [mode|elevate|demote]');
    if (!action) {
      const data = await request(`/api/sessions/${sessionId}/permission`);
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const body =
      action === 'elevate' || action === 'demote'
        ? { shift: action }
        : { mode: action };
    const data = await request(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === 'daemon' && subcommand === 'restart-status') {
    const data = (await request('/api/daemon/restart-request')) as { restartRequest: unknown };
    console.log(JSON.stringify(data.restartRequest, null, 2));
    return;
  }
  if (command === 'daemon' && subcommand === 'restart-ack') {
    await request('/api/daemon/restart-request/ack', { method: 'POST' });
    console.log('acknowledged');
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
