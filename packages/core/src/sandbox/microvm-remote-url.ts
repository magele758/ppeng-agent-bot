/**
 * Resolve the HTTP base URL for in-house agent-sandbox-microvm /exec.
 *
 * Prefer explicit env; fall back to well-known local adapter ports used in lab.
 * Virt (Firecracker/cloud-hypervisor) may be absent — callers should mock /exec
 * in tests. See README-microvm.md.
 */

export function resolveMicrovmRemoteUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (
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

/** Prefer microvm URL, else generic remote URL (existing RemoteVm behavior). */
export function resolveRemoteVmExecBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const micro = resolveMicrovmRemoteUrl(env);
  if (micro) return micro;
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
