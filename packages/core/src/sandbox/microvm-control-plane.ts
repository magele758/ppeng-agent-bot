/**
 * Thin client for agent-sandbox-microvm control-plane lifecycle:
 * create → guest health → delete.
 *
 * Base URL: MICROVM_URL (preferred) or RAW_AGENT_SANDBOX_MICROVM_URL.
 * Auth: MICROVM_API_KEY or BOOTSTRAP_API_KEY / E2B_API_KEY via X-API-Key.
 *
 * Does not talk to vendor E2B; only the in-house Ubuntu1 (:18081) API shape
 * from magele758/agent-sandbox-microvm public-api.md.
 */

import { resolveMicrovmRemoteUrl } from './microvm-remote-url.js';

export function resolveMicrovmApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = (
    env.MICROVM_API_KEY ??
    env.BOOTSTRAP_API_KEY ??
    env.E2B_API_KEY ??
    env.RAW_AGENT_SANDBOX_MICROVM_API_KEY ??
    ''
  ).trim();
  return key || undefined;
}

export interface MicrovmSandboxCreateBody {
  templateID?: string;
  timeout?: number;
  allow_internet_access?: boolean;
  metadata?: Record<string, string>;
  envVars?: Record<string, string>;
}

export interface MicrovmSandbox {
  sandboxID: string;
  templateID?: string;
  clientID?: string;
  envdVersion?: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
  domain?: string;
  startedAt?: string;
  endAt?: string;
  cpuCount?: number;
  memoryMB?: number;
  diskSizeMB?: number;
  state?: string;
}

export interface MicrovmInternalRoute {
  sandboxID: string;
  state: string;
  guestURL: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
}

function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const u = resolveMicrovmRemoteUrl(env);
  if (!u) {
    throw new Error('[microvm] MICROVM_URL / RAW_AGENT_SANDBOX_MICROVM_URL is not configured');
  }
  return u.replace(/\/$/, '');
}

function apiKeyOrThrow(env: NodeJS.ProcessEnv = process.env): string {
  const key = resolveMicrovmApiKey(env);
  if (!key) {
    throw new Error('[microvm] MICROVM_API_KEY (or BOOTSTRAP_API_KEY) is not configured');
  }
  return key;
}

async function readJson(res: Response): Promise<{ status: number; ok: boolean; raw: string; json: any }> {
  const raw = await res.text();
  let json: any = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, raw, json };
}

/** POST /sandboxes → 201 Sandbox */
export async function createMicrovmSandbox(
  body: MicrovmSandboxCreateBody = {},
  options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<{ status: number; sandbox: MicrovmSandbox; raw: string }> {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl(env)}/sandboxes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-API-Key': apiKeyOrThrow(env)
    },
    body: JSON.stringify({
      templateID: body.templateID ?? 'base',
      timeout: body.timeout ?? 120,
      ...(body.allow_internet_access !== undefined
        ? { allow_internet_access: body.allow_internet_access }
        : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      ...(body.envVars ? { envVars: body.envVars } : {})
    }),
    signal: options?.signal
  });
  const { status, ok, raw, json } = await readJson(res);
  if (!ok || status !== 201 || typeof json?.sandboxID !== 'string') {
    throw new Error(`[microvm] create failed HTTP ${status}: ${raw.slice(0, 800)}`);
  }
  return { status, sandbox: json as MicrovmSandbox, raw };
}

/** GET /internal/routes/{id} with Bearer INTERNAL_TOKEN (optional) then guest /health */
export async function getMicrovmGuestHealth(
  sandboxID: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    guestURL?: string;
    envdAccessToken?: string;
  }
): Promise<{ status: number; guestURL: string; body: any; raw: string }> {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;
  let guestURL = (options?.guestURL ?? '').trim();
  let envdAccessToken = (options?.envdAccessToken ?? '').trim();

  if (!guestURL) {
    const internal = (env.MICROVM_INTERNAL_TOKEN ?? env.INTERNAL_TOKEN ?? '').trim();
    if (!internal) {
      throw new Error(
        '[microvm] guestURL not provided and MICROVM_INTERNAL_TOKEN / INTERNAL_TOKEN missing for /internal/routes'
      );
    }
    const routeRes = await fetchImpl(`${baseUrl(env)}/internal/routes/${encodeURIComponent(sandboxID)}`, {
      headers: { Authorization: `Bearer ${internal}` },
      signal: options?.signal
    });
    const route = await readJson(routeRes);
    if (!route.ok || typeof route.json?.guestURL !== 'string') {
      throw new Error(`[microvm] internal routes failed HTTP ${route.status}: ${route.raw.slice(0, 800)}`);
    }
    guestURL = String(route.json.guestURL).replace(/\/$/, '');
    if (!envdAccessToken && typeof route.json.envdAccessToken === 'string') {
      envdAccessToken = route.json.envdAccessToken;
    }
  } else {
    guestURL = guestURL.replace(/\/$/, '');
  }

  const headers: Record<string, string> = {};
  if (envdAccessToken) headers['X-Access-Token'] = envdAccessToken;
  const res = await fetchImpl(`${guestURL}/health`, { headers, signal: options?.signal });
  const { status, ok, raw, json } = await readJson(res);
  if (!ok) {
    throw new Error(`[microvm] guest health failed HTTP ${status}: ${raw.slice(0, 800)}`);
  }
  return { status, guestURL, body: json, raw };
}

/** DELETE /sandboxes/{id} → 204 */
export async function deleteMicrovmSandbox(
  sandboxID: string,
  options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<{ status: number }> {
  const env = options?.env ?? process.env;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl(env)}/sandboxes/${encodeURIComponent(sandboxID)}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': apiKeyOrThrow(env) },
    signal: options?.signal
  });
  if (res.status !== 204) {
    const raw = await res.text();
    throw new Error(`[microvm] delete failed HTTP ${res.status}: ${raw.slice(0, 800)}`);
  }
  return { status: 204 };
}

/**
 * Smoke path: create → guest /health → delete.
 * Returns evidence for operators; throws on any step failure.
 */
export async function smokeMicrovmLifecycle(
  options?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutSeconds?: number;
  }
): Promise<{
  createStatus: number;
  sandboxID: string;
  guestHealthStatus: number;
  guestURL: string;
  deleteStatus: number;
}> {
  const env = options?.env ?? process.env;
  const created = await createMicrovmSandbox(
    { templateID: 'base', timeout: options?.timeoutSeconds ?? 120 },
    { env, fetchImpl: options?.fetchImpl }
  );
  const sid = created.sandbox.sandboxID;
  try {
    const health = await getMicrovmGuestHealth(sid, {
      env,
      fetchImpl: options?.fetchImpl,
      envdAccessToken: created.sandbox.envdAccessToken
    });
    const deleted = await deleteMicrovmSandbox(sid, { env, fetchImpl: options?.fetchImpl });
    return {
      createStatus: created.status,
      sandboxID: sid,
      guestHealthStatus: health.status,
      guestURL: health.guestURL,
      deleteStatus: deleted.status
    };
  } catch (err) {
    try {
      await deleteMicrovmSandbox(sid, { env, fetchImpl: options?.fetchImpl });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
