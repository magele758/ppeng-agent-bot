import { createLogger } from '../logger.js';
import type { AgentSandbox, AgentSandboxExecRequest, AgentSandboxExecResult } from './agent-sandbox-types.js';
import { commandHardlineSandboxResult } from './command-hardline.js';
import { explicitNetworkAllowed } from './os-sandbox.js';
import { postMicrovmExec, resolveRemoteVmExecBaseUrl } from './microvm-remote-url.js';

const log = createLogger('sandbox-remote-vm');

/**
 * E2B-like / in-house microVM sandbox: run commands via HTTP POST /exec.
 *
 * URL resolution prefers agent-sandbox-microvm (`RAW_AGENT_SANDBOX_MICROVM_URL`)
 * then generic `RAW_AGENT_SANDBOX_REMOTE_URL`. See README-microvm.md.
 */
export class RemoteVmAgentSandbox implements AgentSandbox {
  readonly kind = 'remote_vm' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async execute(req: AgentSandboxExecRequest): Promise<AgentSandboxExecResult> {
    const denied = commandHardlineSandboxResult(req.command, 'remote_vm');
    if (denied) return denied;
    const base = resolveRemoteVmExecBaseUrl(this.env);
    if (!base) {
      log.warn('remote/microvm URL unset; remote_vm sandbox returns synthetic failure');
      return {
        stdout: '',
        stderr:
          '[sandbox:remote_vm] RAW_AGENT_SANDBOX_MICROVM_URL / RAW_AGENT_SANDBOX_REMOTE_URL is not configured. ' +
          'Point it at agent-sandbox-microvm /exec or an E2B-like adapter (see packages/core/src/sandbox/README-microvm.md).',
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

    const backend =
      (this.env.RAW_AGENT_SANDBOX_REMOTE_BACKEND ?? '').trim().toLowerCase().includes('microvm') ||
      Boolean((this.env.RAW_AGENT_SANDBOX_MICROVM_URL ?? '').trim())
        ? 'remote_vm-microvm'
        : 'remote_vm-http';

    try {
      const { ok, status, raw, parsed } = await postMicrovmExec(
        base,
        {
          command: req.command,
          cwd: req.cwd,
          workspace: req.workspace,
          timeoutMs: req.timeoutMs,
          allowNetwork: explicitNetworkAllowed(req.allowNetwork),
          sessionId: req.sessionId
        },
        { signal: controller.signal }
      );
      if (!ok) {
        return {
          stdout: '',
          stderr: raw.slice(0, 8000) || `HTTP ${status}`,
          code: 1,
          signal: null,
          kind: 'remote_vm',
          backend
        };
      }
      return {
        stdout: String(parsed.stdout ?? ''),
        stderr: String(parsed.stderr ?? ''),
        code: typeof parsed.code === 'number' ? parsed.code : 0,
        signal: null,
        kind: 'remote_vm',
        backend
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: '',
        stderr: `[sandbox:remote_vm] ${msg}`,
        code: 1,
        signal: null,
        kind: 'remote_vm',
        backend
      };
    } finally {
      if (t) clearTimeout(t);
    }
  }
}
