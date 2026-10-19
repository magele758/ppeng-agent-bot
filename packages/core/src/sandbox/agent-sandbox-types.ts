/**
 * Agent-facing sandbox abstraction: how *agent tools* run commands, independent
 * of whether execution is local OS-bound, remote VM (E2B-like), or a pool worker.
 *
 * Naming
 * ------
 * - **Native**: same host, Tier-0 env sanitize + Tier-1 seatbelt/bwrap (existing).
 * - **Remote VM (E2B-like)**: ephemeral isolated environment via vendor API
 *   (E2B, Modal, Daytona, etc.) — HTTP/SDK, not local spawn.
 * - **Microservice**: dedicated runner service (sidecar / K8s Job / gateway) —
 *   policy + quota at the service boundary; core only speaks HTTP/gRPC.
 */

export type AgentSandboxKind = 'native' | 'remote_vm' | 'microservice';

/** Normalized exec result for tools (bash, bg_run, etc.). */
export interface AgentSandboxExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  kind: AgentSandboxKind;
  /** Concrete backend id, e.g. `sandbox-exec`, `bwrap`, `e2b`, `runner-http`. */
  backend: string;
}

export interface AgentSandboxExecRequest {
  command: string;
  cwd: string;
  workspace: string | string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  allowNetwork?: boolean;
  /** Optional affinity for remote/microservice routing or auditing. */
  sessionId?: string;
  /**
   * Per-call isolation for the native runner. Omit to keep that runner's
   * configured mode. Shell tools pass an explicit mode so a saved setting
   * cannot weaken the call.
   */
  isolation?: 'auto' | 'direct' | 'os' | 'container' | 'cloudflare-computer';
}

export interface AgentSandbox {
  readonly kind: AgentSandboxKind;
  execute(req: AgentSandboxExecRequest): Promise<AgentSandboxExecResult>;
}
