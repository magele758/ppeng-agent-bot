/**
 * Opt-in, default-OFF HTTP client for Password One blind credential broker.
 *
 * Zero external runtime dependencies (`node:http` / `node:https` only).
 * Does NOT register any model tool and performs zero work on module import.
 * Reads `RAW_AGENT_PASSWORD_ONE_URL` / `PW1_URL` and `PW1_BROKER_TOKEN`
 * (from ALS secret overrides, bound SecretVault, or env) only when called.
 */

import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { currentSecretOverrides, getBoundSecretVault } from './secret-vault.js';

export const DEFAULT_PASSWORD_ONE_TIMEOUT_MS = 15_000;
export const MAX_PASSWORD_ONE_RESPONSE_BYTES = 2 * 1024 * 1024;

const CRLF_OR_CTRL_RE = /[\r\n\0]/;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type PasswordOneAllowedToolKind = 'http' | 'exec';
export type PasswordOneCrossOriginRedirectMode = 'block' | 'strip';

export interface PasswordOneSecretPolicy {
  allowedHosts: string[];
  allowedTools: PasswordOneAllowedToolKind[];
  allowedCommands: string[];
  allowHttp: boolean;
  allowEnvInjection: boolean;
  crossOriginRedirect: PasswordOneCrossOriginRedirectMode;
  maxLeaseTtlSeconds: number;
  requireGrant: boolean;
}

export interface PasswordOneHandle {
  id: string;
  alias: string;
  handle: string;
  placeholder: string;
  description: string;
  version: number;
  policy: PasswordOneSecretPolicy;
  policyHash: string;
  createdAt: string;
  updatedAt: string;
}

export type PasswordOneHttpAuthBinding =
  | { type: 'bearer'; secret: string }
  | { type: 'basic'; username: string; secret: string }
  | { type: 'header'; headerName: string; secret: string; prefix?: string }
  | { type: 'query'; paramName: string; secret: string };

export interface PasswordOneHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
  auth?: PasswordOneHttpAuthBinding;
  agentId?: string;
  grantId?: string;
  maxRedirects?: number;
  timeoutMs?: number;
}

export interface PasswordOneRedirectHop {
  fromUrl: string;
  toUrl: string;
  statusCode: number;
  crossOrigin: boolean;
  strippedCredentials: boolean;
}

export interface PasswordOneHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirects: PasswordOneRedirectHop[];
  redactionsCount: number;
  redactedAliases: string[];
  durationMs: number;
}

export interface PasswordOneExecRequest {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  agentId?: string;
  grantId?: string;
}

export interface PasswordOneExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  redactionsCount: number;
  redactedAliases: string[];
  durationMs: number;
}

export interface PasswordOneScrubMatch {
  label: string;
  encoding: string;
  count: number;
}

export interface PasswordOneScrubResult {
  scrubbedText: string;
  redactionsCount: number;
  redactedAliases: string[];
  matches: PasswordOneScrubMatch[];
}

export interface PasswordOneAuditVerification {
  valid: boolean;
  entriesChecked: number;
  headHash: string;
  brokenAtSeq?: number;
  reason?: string;
}

export interface PasswordOneAuditEntry {
  seq: number;
  eventId: string;
  timestamp: string;
  action: string;
  alias: string | null;
  agentId: string | null;
  grantId: string | null;
  toolName: string | null;
  target: string | null;
  decision: string;
  reason: string;
  redactionsCount: number;
  metadata: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

export interface PasswordOneAuditResult {
  verification: PasswordOneAuditVerification;
  entries: PasswordOneAuditEntry[];
}

export interface PasswordOneClientOptions {
  /** Override base URL (otherwise reads RAW_AGENT_PASSWORD_ONE_URL or PW1_URL). */
  baseUrl?: string;
  /** Override broker auth token (otherwise reads PW1_BROKER_TOKEN / PW1_AUTH_TOKEN from ALS, SecretVault, or env). */
  token?: string;
  /** Request timeout in milliseconds (default: 15_000). */
  timeoutMs?: number;
  /** Maximum response payload in bytes (default: 2 MiB). */
  maxResponseBytes?: number;
  /** Optional extra request headers (strictly validated against CRLF injection). */
  headers?: Record<string, string>;
  /** Optional env source override (defaults to process.env). */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Optional AbortSignal for request cancellation. */
  signal?: AbortSignal;
}

export interface ResolvedPasswordOneConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  headers: Record<string, string>;
}

export class PasswordOneClientError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(code: string, message: string, statusCode?: number) {
    super(message);
    this.name = 'PasswordOneClientError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function assertNoControlChars(value: string, label: string): void {
  if (CRLF_OR_CTRL_RE.test(value)) {
    throw new PasswordOneClientError(
      'INVALID_INPUT',
      `Password One ${label} contains forbidden control characters (CR/LF/NUL)`
    );
  }
}

function validateHeaderMap(
  headers: Record<string, string> | undefined,
  label: string
): Record<string, string> {
  if (!headers) return {};
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== 'string' || !HTTP_HEADER_NAME_RE.test(key)) {
      throw new PasswordOneClientError('INVALID_INPUT', `Invalid HTTP header name in ${label}`);
    }
    if (typeof value !== 'string') {
      throw new PasswordOneClientError('INVALID_INPUT', `Invalid HTTP header value in ${label}`);
    }
    assertNoControlChars(value, `${label} header value`);
    validated[key] = value;
  }
  return validated;
}

function normalizeBaseUrl(rawUrl: string): string {
  assertNoControlChars(rawUrl, 'base URL');
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new PasswordOneClientError('INVALID_INPUT', 'Password One base URL must not be empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PasswordOneClientError('INVALID_INPUT', 'Password One base URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PasswordOneClientError(
      'INVALID_INPUT',
      `Password One base URL protocol must be http: or https: (got ${parsed.protocol})`
    );
  }
  if (parsed.username || parsed.password) {
    throw new PasswordOneClientError(
      'INVALID_INPUT',
      'Password One base URL must not embed credentials in URL userinfo'
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

function resolveBrokerToken(
  explicitToken: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string | undefined {
  let raw: string | undefined;
  if (explicitToken !== undefined) {
    raw = explicitToken;
  } else {
    const als = currentSecretOverrides();
    const vault = getBoundSecretVault();
    raw =
      als.PW1_BROKER_TOKEN ??
      vault?.get('PW1_BROKER_TOKEN') ??
      env.PW1_BROKER_TOKEN ??
      als.PW1_AUTH_TOKEN ??
      vault?.get('PW1_AUTH_TOKEN') ??
      env.PW1_AUTH_TOKEN;
  }
  if (raw === undefined) return undefined;
  assertNoControlChars(raw, 'auth token');
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function collectTokenForms(token: string): string[] {
  const forms = new Set<string>([token]);
  const encoded = encodeURIComponent(token);
  if (encoded !== token) {
    forms.add(encoded);
    forms.add(encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  }
  const json = JSON.stringify(token).slice(1, -1);
  if (json !== token) forms.add(json);
  const buf = Buffer.from(token, 'utf8');
  const b64Std = buf.toString('base64');
  forms.add(b64Std);
  if (b64Std.endsWith('=')) forms.add(b64Std.replace(/=+$/, ''));
  forms.add(buf.toString('base64url'));
  forms.add(b64Std.replace(/\+/g, '-').replace(/\//g, '_'));
  return [...forms]
    .filter((form) => form.length >= Math.min(4, token.length))
    .sort((a, b) => b.length - a.length);
}

function scrubTokenFromText(text: string, token: string | undefined): string {
  let out = text;
  if (token) {
    for (const form of collectTokenForms(token)) {
      if (out.includes(form)) {
        out = out.split(form).join('[REDACTED:PW1_BROKER_TOKEN]');
      }
    }
    out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED:PW1_BROKER_TOKEN]');
  }
  return out;
}

/**
 * Resolve Password One client configuration from explicit options, ALS overrides,
 * bound SecretVault, and environment variables (`RAW_AGENT_PASSWORD_ONE_URL` / `PW1_URL`).
 * Returns `undefined` when no base URL is configured (opt-in, default-OFF).
 */
export function resolvePasswordOneConfig(
  options?: PasswordOneClientOptions
): ResolvedPasswordOneConfig | undefined {
  const env = options?.env ?? process.env;
  const rawUrl = options?.baseUrl ?? env.RAW_AGENT_PASSWORD_ONE_URL ?? env.PW1_URL;
  if (rawUrl !== undefined) {
    assertNoControlChars(rawUrl, 'base URL');
  }
  if (rawUrl === undefined || rawUrl.trim() === '') {
    // Still validate explicit token/headers if caller supplied them for early fail-closed checks.
    if (options?.token !== undefined) assertNoControlChars(options.token, 'auth token');
    if (options?.headers !== undefined) validateHeaderMap(options.headers, 'client options');
    return undefined;
  }
  const baseUrl = normalizeBaseUrl(rawUrl);
  const token = resolveBrokerToken(options?.token, env);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PASSWORD_ONE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PasswordOneClientError('INVALID_INPUT', 'Password One timeoutMs must be a positive number');
  }
  const maxResponseBytes = options?.maxResponseBytes ?? MAX_PASSWORD_ONE_RESPONSE_BYTES;
  if (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0 || !Number.isInteger(maxResponseBytes)) {
    throw new PasswordOneClientError(
      'INVALID_INPUT',
      'Password One maxResponseBytes must be a positive integer'
    );
  }
  const headers = validateHeaderMap(options?.headers, 'client options');
  return { baseUrl, token, timeoutMs, maxResponseBytes, headers };
}

function validateProxyHttpRequest(req: PasswordOneHttpRequest): void {
  if (!req || typeof req.url !== 'string' || !req.url.trim()) {
    throw new PasswordOneClientError('INVALID_INPUT', 'proxyHttp requires a non-empty url');
  }
  assertNoControlChars(req.url, 'proxyHttp url');
  if (req.method !== undefined) assertNoControlChars(req.method, 'proxyHttp method');
  if (req.headers) validateHeaderMap(req.headers, 'proxyHttp');
  if (req.auth) {
    assertNoControlChars(req.auth.secret, 'proxyHttp auth secret');
    if (req.auth.type === 'header') {
      if (!HTTP_HEADER_NAME_RE.test(req.auth.headerName)) {
        throw new PasswordOneClientError('INVALID_INPUT', 'Invalid HTTP header name in proxyHttp auth');
      }
      if (req.auth.prefix !== undefined) assertNoControlChars(req.auth.prefix, 'proxyHttp auth prefix');
    } else if (req.auth.type === 'basic') {
      assertNoControlChars(req.auth.username, 'proxyHttp auth username');
    } else if (req.auth.type === 'query') {
      assertNoControlChars(req.auth.paramName, 'proxyHttp auth paramName');
    }
  }
}

function validateProxyExecRequest(req: PasswordOneExecRequest): void {
  if (!req || typeof req.command !== 'string' || !req.command.trim()) {
    throw new PasswordOneClientError('INVALID_INPUT', 'proxyExec requires a non-empty command');
  }
  assertNoControlChars(req.command, 'proxyExec command');
}

function requestJson<T>(
  config: ResolvedPasswordOneConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const targetUrl = new URL(path, `${config.baseUrl}/`);
    const bodyBuffer = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
    const headers: Record<string, string> = {
      accept: 'application/json'
    };
    for (const [k, v] of Object.entries(config.headers)) {
      if (config.token && k.toLowerCase() === 'authorization') continue;
      headers[k] = v;
    }
    if (bodyBuffer) {
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(bodyBuffer.length);
    }
    if (config.token) {
      headers.authorization = `Bearer ${config.token}`;
    }

    const reqOptions: RequestOptions = {
      method,
      headers
    };

    const transport = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeRes: IncomingMessage | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (err: PasswordOneClientError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const req = transport(targetUrl, reqOptions, (res) => {
      activeRes = res;
      const statusCode = res.statusCode ?? 0;
      const declaredLen = res.headers['content-length'];
      if (typeof declaredLen === 'string') {
        const parsedLen = Number(declaredLen);
        if (Number.isFinite(parsedLen) && parsedLen > config.maxResponseBytes) {
          res.destroy();
          req.destroy();
          fail(
            new PasswordOneClientError(
              'RESPONSE_TOO_LARGE',
              `Password One response exceeded maximum size of ${config.maxResponseBytes} bytes`,
              statusCode
            )
          );
          return;
        }
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        totalBytes += buf.length;
        if (totalBytes > config.maxResponseBytes) {
          res.destroy();
          req.destroy();
          fail(
            new PasswordOneClientError(
              'RESPONSE_TOO_LARGE',
              `Password One response exceeded maximum size of ${config.maxResponseBytes} bytes`,
              statusCode
            )
          );
          return;
        }
        chunks.push(buf);
      });

      res.on('end', () => {
        if (settled) return;
        const rawText = Buffer.concat(chunks).toString('utf8').trim();
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
        } catch {
          fail(
            new PasswordOneClientError(
              'INVALID_RESPONSE',
              scrubTokenFromText(
                `Password One returned malformed JSON (HTTP ${statusCode})`,
                config.token
              ),
              statusCode
            )
          );
          return;
        }

        if (statusCode >= 400 || parsed.ok === false) {
          const errRecord =
            parsed.error && typeof parsed.error === 'object'
              ? (parsed.error as Record<string, unknown>)
              : undefined;
          const rawCode =
            typeof errRecord?.code === 'string' && errRecord.code.trim()
              ? errRecord.code.trim()
              : 'HTTP_ERROR';
          const rawMessage =
            typeof errRecord?.message === 'string' && errRecord.message.trim()
              ? errRecord.message.trim()
              : `Password One request failed with HTTP ${statusCode}`;
          fail(
            new PasswordOneClientError(
              scrubTokenFromText(rawCode, config.token),
              scrubTokenFromText(rawMessage, config.token),
              statusCode
            )
          );
          return;
        }

        succeed(parsed as T);
      });

      res.on('error', (err: Error) => {
        fail(
          new PasswordOneClientError(
            'NETWORK_ERROR',
            scrubTokenFromText(`Password One response error: ${err.message}`, config.token)
          )
        );
      });
    });

    const onAbort = (): void => {
      activeRes?.destroy();
      req.destroy();
      fail(new PasswordOneClientError('ABORTED', 'Password One request aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      activeRes?.destroy();
      req.destroy();
      fail(
        new PasswordOneClientError(
          'TIMEOUT',
          `Password One request timed out after ${config.timeoutMs}ms`
        )
      );
    }, config.timeoutMs);

    req.on('error', (err: Error) => {
      fail(
        new PasswordOneClientError(
          'NETWORK_ERROR',
          scrubTokenFromText(`Password One network error: ${err.message}`, config.token)
        )
      );
    });

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

export class PasswordOneClient {
  readonly #options?: PasswordOneClientOptions;

  constructor(options?: PasswordOneClientOptions) {
    if (options?.token !== undefined) assertNoControlChars(options.token, 'auth token');
    if (options?.headers !== undefined) validateHeaderMap(options.headers, 'client options');
    if (options?.baseUrl !== undefined && options.baseUrl !== '') normalizeBaseUrl(options.baseUrl);
    this.#options = options;
  }

  private resolveOrThrow(): ResolvedPasswordOneConfig {
    const config = resolvePasswordOneConfig(this.#options);
    if (!config) {
      throw new PasswordOneClientError(
        'NOT_CONFIGURED',
        'Password One URL is not configured (set RAW_AGENT_PASSWORD_ONE_URL or PW1_URL)'
      );
    }
    return config;
  }

  async listHandles(): Promise<PasswordOneHandle[]> {
    const config = this.resolveOrThrow();
    const res = await requestJson<{ ok: true; secrets: PasswordOneHandle[] }>(
      config,
      'GET',
      '/v1/secrets',
      undefined,
      this.#options?.signal
    );
    return Array.isArray(res.secrets) ? res.secrets : [];
  }

  async proxyHttp(req: PasswordOneHttpRequest): Promise<PasswordOneHttpResponse> {
    validateProxyHttpRequest(req);
    const config = this.resolveOrThrow();
    const res = await requestJson<{ ok: true; result: PasswordOneHttpResponse }>(
      config,
      'POST',
      '/v1/proxy/http',
      req,
      this.#options?.signal
    );
    return res.result;
  }

  async proxyExec(req: PasswordOneExecRequest): Promise<PasswordOneExecResponse> {
    validateProxyExecRequest(req);
    const config = this.resolveOrThrow();
    const res = await requestJson<{ ok: true; result: PasswordOneExecResponse }>(
      config,
      'POST',
      '/v1/proxy/exec',
      req,
      this.#options?.signal
    );
    return res.result;
  }

  async scrubText(text: string, source?: string): Promise<PasswordOneScrubResult> {
    if (typeof text !== 'string') {
      throw new PasswordOneClientError('INVALID_INPUT', 'scrubText requires a string');
    }
    const config = this.resolveOrThrow();
    const res = await requestJson<{ ok: true; result: PasswordOneScrubResult }>(
      config,
      'POST',
      '/v1/scrub',
      source ? { text, source } : { text },
      this.#options?.signal
    );
    return res.result;
  }

  async verifyAudit(limit?: number): Promise<PasswordOneAuditResult> {
    let path = '/v1/audit';
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new PasswordOneClientError('INVALID_INPUT', 'verifyAudit limit must be a positive integer');
      }
      path = `/v1/audit?limit=${limit}`;
    }
    const config = this.resolveOrThrow();
    const res = await requestJson<{
      ok: true;
      verification: PasswordOneAuditVerification;
      entries: PasswordOneAuditEntry[];
    }>(config, 'GET', path, undefined, this.#options?.signal);
    return {
      verification: res.verification,
      entries: Array.isArray(res.entries) ? res.entries : []
    };
  }
}

export function createPasswordOneClient(options?: PasswordOneClientOptions): PasswordOneClient {
  return new PasswordOneClient(options);
}

export function listHandles(options?: PasswordOneClientOptions): Promise<PasswordOneHandle[]> {
  return new PasswordOneClient(options).listHandles();
}

export function proxyHttp(
  req: PasswordOneHttpRequest,
  options?: PasswordOneClientOptions
): Promise<PasswordOneHttpResponse> {
  return new PasswordOneClient(options).proxyHttp(req);
}

export function proxyExec(
  req: PasswordOneExecRequest,
  options?: PasswordOneClientOptions
): Promise<PasswordOneExecResponse> {
  return new PasswordOneClient(options).proxyExec(req);
}

export function scrubText(
  text: string,
  options?: PasswordOneClientOptions & { source?: string }
): Promise<PasswordOneScrubResult> {
  return new PasswordOneClient(options).scrubText(text, options?.source);
}

export function verifyAudit(
  options?: PasswordOneClientOptions & { limit?: number }
): Promise<PasswordOneAuditResult> {
  return new PasswordOneClient(options).verifyAudit(options?.limit);
}
