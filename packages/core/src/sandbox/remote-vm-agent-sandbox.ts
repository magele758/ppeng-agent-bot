import { createLogger } from '../logger.js';
import type { AgentSandbox, AgentSandboxExecRequest, AgentSandboxExecResult } from './agent-sandbox-types.js';
import { commandHardlineSandboxResult } from './command-hardline.js';
import { explicitNetworkAllowed } from './os-sandbox.js';

const log = createLogger('sandbox-remote-vm');

/**
 * E2B-like sandbox: run commands in an ephemeral remote environment.
 *
 * Extension points (not implemented — wire your vendor SDK or HTTP here):
 * - `RAW_AGENT_SANDBOX_REMOTE_URL` — base URL for a small adapter service, or
 * - vendor-specific env (E2B_API_KEY, etc.) if you call SDK from this process.
 *
 * Expected adapter contract (suggested): `POST /exec` JSON body
 * `{ command, cwd, workspace, timeoutMs, allowNetwork, sessionId }` →
 * `{ stdout, stderr, code }`.
 */
export class RemoteVmAgentSandbox implements AgentSandbox {
  readonly kind = 'remote_vm' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async execute(req: AgentSandboxExecRequest): Promise<AgentSandboxExecResult> {
    const denied = commandHardlineSandboxResult(req.command, 'remote_vm');
    if (denied) return denied;
    const base = (this.env.RAW_AGENT_SANDBOX_REMOTE_URL ?? '').trim().replace(/\/$/, '');
    if (!base) {
      log.warn('RAW_AGENT_SANDBOX_REMOTE_URL unset; remote_vm sandbox returns synthetic failure');
      return {
        stdout: '',
        stderr:
          '[sandbox:remote_vm] RAW_AGENT_SANDBOX_REMOTE_URL is not configured. ' +
          'Point it at an E2B-like adapter or implement vendor SDK in RemoteVmAgentSandbox.',
        code: 127,
        signal: null,
        kind: 'remote_vm',
        backend: 'remote_vm-unconfigured'
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
      const res = await fetch(`${base}/exec`, {
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
          kind: 'remote_vm',
          backend: 'remote_vm-http'
        };
      }
      return {
        stdout: String(parsed.stdout ?? ''),
        stderr: String(parsed.stderr ?? ''),
        code: typeof parsed.code === 'number' ? parsed.code : 0,
        signal: null,
        kind: 'remote_vm',
        backend: 'remote_vm-http'
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: '',
        stderr: `[sandbox:remote_vm] ${msg}`,
        code: 1,
        signal: null,
        kind: 'remote_vm',
        backend: 'remote_vm-http'
      };
    } finally {
      if (t) clearTimeout(t);
    }
  }
}
