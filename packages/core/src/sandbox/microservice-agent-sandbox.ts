import { createLogger } from '../logger.js';
import type { AgentSandbox, AgentSandboxExecRequest, AgentSandboxExecResult } from './agent-sandbox-types.js';
import { commandHardlineSandboxResult } from './command-hardline.js';
import { explicitNetworkAllowed } from './os-sandbox.js';

const log = createLogger('sandbox-microservice');

/**
 * Microservice-level runner: agent-core treats execution as RPC to a pool
 * (K8s Job worker, dedicated daemon, internal gateway).
 *
 * Suggested env:
 * - `RAW_AGENT_SANDBOX_RUNNER_URL` — e.g. https://agent-runner.internal/v1
 *
 * Suggested contract: `POST /run` with same JSON as remote_vm; response ditto.
 * You may later split: allocate sandbox → run → release, for long-lived runners.
 */
export class MicroserviceAgentSandbox implements AgentSandbox {
  readonly kind = 'microservice' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async execute(req: AgentSandboxExecRequest): Promise<AgentSandboxExecResult> {
    const denied = commandHardlineSandboxResult(req.command, 'microservice');
    if (denied) return denied;
    const base = (this.env.RAW_AGENT_SANDBOX_RUNNER_URL ?? '').trim().replace(/\/$/, '');
    if (!base) {
      log.warn('RAW_AGENT_SANDBOX_RUNNER_URL unset; microservice sandbox returns synthetic failure');
      return {
        stdout: '',
        stderr:
          '[sandbox:microservice] RAW_AGENT_SANDBOX_RUNNER_URL is not configured. ' +
          'Deploy a runner service and set this to its base URL.',
        code: 127,
        signal: null,
        kind: 'microservice',
        backend: 'microservice-unconfigured'
      };
    }

    const controller = new AbortController();
    const t = req.timeoutMs && req.timeoutMs > 0 ? setTimeout(() => controller.abort(), req.timeoutMs) : undefined;
    if (req.signal) {
      const onAbort = () => controller.abort();
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: req.command,
          cwd: req.cwd,
          workspace: req.workspace,
          timeoutMs: req.timeoutMs,
          allowNetwork: explicitNetworkAllowed(req.allowNetwork),
          sessionId: req.sessionId
        }),
        signal: controller.signal
      });
      const raw = await res.text();
      let parsed: { stdout?: string; stderr?: string; code?: number } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        /* ignore */
      }
      if (!res.ok) {
        return {
          stdout: '',
          stderr: raw.slice(0, 8000) || `HTTP ${res.status}`,
          code: 1,
          signal: null,
          kind: 'microservice',
          backend: 'runner-http'
        };
      }
      return {
        stdout: String(parsed.stdout ?? ''),
        stderr: String(parsed.stderr ?? ''),
        code: typeof parsed.code === 'number' ? parsed.code : 0,
        signal: null,
        kind: 'microservice',
        backend: 'runner-http'
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: '',
        stderr: `[sandbox:microservice] ${msg}`,
        code: 1,
        signal: null,
        kind: 'microservice',
        backend: 'runner-http'
      };
    } finally {
      if (t) clearTimeout(t);
    }
  }
}
