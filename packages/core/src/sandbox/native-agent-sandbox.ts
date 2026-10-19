import type { AgentSandbox, AgentSandboxExecRequest, AgentSandboxExecResult } from './agent-sandbox-types.js';
import { commandHardlineSandboxResult } from './command-hardline.js';
import { SandboxManager, type SandboxModeResolver } from './os-sandbox.js';

/**
 * Wraps existing {@link SandboxManager} (Tier 0 + Tier 1 on capable hosts,
 * or Cloudflare Computer when Lab mode is `cloudflare-computer`).
 */
export class NativeAgentSandbox implements AgentSandbox {
  readonly kind = 'native' as const;
  private readonly manager: SandboxManager;

  constructor(mode: SandboxModeResolver = 'auto') {
    this.manager = new SandboxManager(mode);
  }

  get backendName(): string {
    return this.manager.activeProvider.name;
  }

  async execute(req: AgentSandboxExecRequest): Promise<AgentSandboxExecResult> {
    const denied = commandHardlineSandboxResult(req.command, 'native');
    if (denied) return denied;
    const r = await this.manager.execute(req.command, req.cwd, {
      workspace: req.workspace,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      allowNetwork: req.allowNetwork,
      sessionId: req.sessionId,
      mode: req.isolation,
      strict: req.isolation !== undefined
    });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      code: r.code,
      signal: r.signal,
      kind: 'native',
      backend: r.backend ?? this.manager.activeProvider.name
    };
  }
}
