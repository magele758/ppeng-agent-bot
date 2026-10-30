/**
 * Resolve the HTTP base URL for in-house agent-sandbox-microvm /exec.
 *
 * Prefer MICROVM_URL, then RAW_AGENT_SANDBOX_MICROVM_URL; fall back to remote_url+backend=microvm.
 * Virt (Firecracker/cloud-hypervisor) may be absent — callers should mock /exec
 * in tests. See README-microvm.md.
 */

export function resolveMicrovmRemoteUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Prefer short MICROVM_URL (ops / Ubuntu1 control-plane), then RAW_AGENT_* aliases.
  const explicit = (
    env.MICROVM_URL ??
    env.RAW_AGENT_SANDBOX_MICROVM_URL ??
    env.RAW_AGENT_AGENT_SANDBOX_MICROVM_URL ??
    ''
  )
    .trim()
    .replace(/\/$/, '');
  if (explicit) return explicit;

  // When remote_vm URL is already set and backend hints microvm, reuse it.
  const remote = (env.RAW_AGENT_SANDBOX_REMOTE_URL ?? '').trim().replace(/\/$/, '');
  const backend = (env.RAW_AGENT_SANDBOX_REMOTE_BACKEND ?? '').trim().toLowerCase();
  if (remote && (backend === 'microvm' || backend === 'agent-sandbox-microvm')) {
    return remote;
  }
  return undefined;
}

const MICROVM_KINDS = new Set(['microvm', 'agent-sandbox-microvm']);

/** True when the operator asked for microVM rather than a generic remote adapter. */
export function demandsMicrovmIsolation(env: NodeJS.ProcessEnv = process.env): boolean {
  const kind = (env.RAW_AGENT_AGENT_SANDBOX_KIND ?? '').trim().toLowerCase();
  const backend = (env.RAW_AGENT_SANDBOX_REMOTE_BACKEND ?? '').trim().toLowerCase();
  return MICROVM_KINDS.has(kind) || MICROVM_KINDS.has(backend);
}

/**
 * MicroVM requests only use a microVM URL. A generic remote URL is not a fallback.
 * Other remote_vm requests may still use RAW_AGENT_SANDBOX_REMOTE_URL.
 */
export function resolveRemoteVmExecBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const micro = resolveMicrovmRemoteUrl(env);
  if (micro) return micro;
  if (demandsMicrovmIsolation(env)) return undefined;
  const remote = (env.RAW_AGENT_SANDBOX_REMOTE_URL ?? '').trim().replace(/\/$/, '');
  return remote || undefined;
}

export interface MicrovmExecRequestBody {
  command: string;
  cwd: string;
  workspace: string | string[];
  timeoutMs?: number;
  allowNetwork?: boolean;
  sessionId?: string;
}

export interface MicrovmExecResponseBody {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Minimal client for POST {base}/exec — shared by RemoteVmAgentSandbox and tests.
 */
export async function postMicrovmExec(
  baseUrl: string,
  body: MicrovmExecRequestBody,
  options?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<{ ok: boolean; status: number; raw: string; parsed: MicrovmExecResponseBody }> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options?.signal
  });
  const raw = await res.text();
  let parsed: MicrovmExecResponseBody = {};
  try {
    parsed = JSON.parse(raw) as MicrovmExecResponseBody;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, raw, parsed };
}

/** Missing numeric exit code is a failed exec, not a silent success. */
export function remoteExecRejection(
  ok: boolean,
  status: number,
  raw: string,
  parsed: { code?: number }
): string | undefined {
  if (!ok) return raw.slice(0, 8000) || `HTTP ${status}`;
  if (typeof parsed.code !== 'number') {
    return '[sandbox:remote_vm] /exec response missing numeric code; command was not treated as success';
  }
  return undefined;
}
