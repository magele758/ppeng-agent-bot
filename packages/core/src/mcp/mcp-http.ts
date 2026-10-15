import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpHttpEndpoint, McpHttpTransport } from './mcp-http-config.js';
import type { McpResourceInfo, McpToolInfo } from './mcp-jsonrpc.js';
import { redactSecrets } from './mcp-redact.js';
import { MCP_OAUTH_AUTHORIZATION_PREFIX, McpOAuthClientProvider } from './mcp-oauth.js';

export { redactSecrets } from './mcp-redact.js';

const DEFAULT_TIMEOUT_MS = 20_000;

export interface McpHttpSessionOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Fired when an unpinned Streamable HTTP connect falls back to legacy SSE. */
  onTransportFallback?: (info: { url: string; status: number }) => void;
  /** OAuth tokens, client registration, and the PKCE verifier are stored here. */
  stateDir?: string;
}

/** Shorter credential values are not full-text replaced; they corrupt identifiers like `identity`. */
export const MIN_CREDENTIAL_LENGTH = 8;

/** Header names that carry credentials. Ordinary headers such as `X-Trace` are not secrets. */
const CREDENTIAL_HEADER_NAME = /authorization|token|secret|key|cookie|auth/i;

const PROTOCOL_STRING_KEYS = new Set(['type', 'format', '$ref']);
const PROTOCOL_ARRAY_KEYS = new Set(['required']);

export interface HeaderSecretReport {
  secrets: string[];
  shortCredentialCount: number;
}

function buildHeaders(endpoint: McpHttpEndpoint, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(endpoint.headers ?? {})) {
    if (value) headers[key] = value;
  }
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuth && endpoint.bearerEnv) {
    const token = env[endpoint.bearerEnv]?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function rememberCredential(value: string, report: HeaderSecretReport): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (trimmed.length < MIN_CREDENTIAL_LENGTH) {
    report.shortCredentialCount += 1;
    return;
  }
  report.secrets.push(trimmed);
}

function rememberHeaderValue(value: string, report: HeaderSecretReport): void {
  const bearer = /^Bearer\s+(\S+)/i.exec(value.trim());
  if (bearer?.[1]) {
    rememberCredential(bearer[1], report);
    return;
  }
  rememberCredential(value, report);
}

/**
 * Secrets worth full-text redacting. Only credential headers and bearerEnv.
 * Values shorter than 8 characters are counted so startup can warn, and are omitted.
 */
export function collectHeaderSecrets(endpoint: McpHttpEndpoint, env: NodeJS.ProcessEnv): HeaderSecretReport {
  const report: HeaderSecretReport = { secrets: [], shortCredentialCount: 0 };
  for (const [name, value] of Object.entries(buildHeaders(endpoint, env))) {
    if (!value || !CREDENTIAL_HEADER_NAME.test(name)) continue;
    rememberHeaderValue(value, report);
  }
  report.secrets = [...new Set(report.secrets)].sort((a, b) => b.length - a.length);
  return report;
}

/** Redact credential text in schema values. Keys, type, format, $ref, and required names stay. */
export function redactProtocolTree(value: unknown, secrets: string[], parentKey?: string): unknown {
  if (typeof value === 'string') {
    if (parentKey && (PROTOCOL_STRING_KEYS.has(parentKey) || PROTOCOL_ARRAY_KEYS.has(parentKey))) return value;
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) return value.map((item) => redactProtocolTree(item, secrets, parentKey));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactProtocolTree(child, secrets, key);
  }
  return out;
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Fallback is status-code only. 404/405 mean the URL does not speak Streamable HTTP.
 * 401/403/406 and message text (including "method not allowed") never qualify.
 * A GET 405 on the Streamable HTTP listener is swallowed by the SDK and is not an error.
 * Explicit `transport: "streamable-http"` does not use this signal.
 */
const LEGACY_SSE_FALLBACK_STATUS = new Set([404, 405]);

export function isLegacySseEndpointError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) return false;
  return LEGACY_SSE_FALLBACK_STATUS.has(code);
}

function fetchWithTimeout(base: FetchLike, timeoutMs: number): FetchLike {
  return async (url, init) => {
    // GET is the long-lived SSE stream. Timing it out would drop the session.
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') return base(url, init);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(url, { ...init, signal });
  };
}

function toolResultToText(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): {
  text: string;
  isError?: boolean;
} {
  const parts = result.content ?? [];
  const text = parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text as string)
    .join('\n');
  return { text: text || JSON.stringify(result), isError: result.isError };
}

function readOnlyHintOf(tool: { annotations?: { readOnlyHint?: boolean } }): boolean | undefined {
  const hint = tool.annotations?.readOnlyHint;
  return typeof hint === 'boolean' ? hint : undefined;
}

/**
 * One MCP client over the official SDK Streamable HTTP transport.
 * `transport: "sse"` uses the legacy SSE transport.
 * `transport: "streamable-http"` never falls back.
 * An omitted transport tries Streamable HTTP and falls back to SSE only on HTTP 404/405.
 * Session id is sent only after the server returns `mcp-session-id`.
 */
export class McpHttpSession {
  readonly index: number;
  private client: Client | undefined;
  private transport: { close(): Promise<void> } | undefined;
  private connected = false;
  private connectPromise: Promise<void> | undefined;
  private oauthProvider: McpOAuthClientProvider | undefined;

  constructor(
    index: number,
    private readonly endpoint: McpHttpEndpoint,
    private readonly options: McpHttpSessionOptions = {}
  ) {
    this.index = index;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().catch((error: unknown) => {
        this.connectPromise = undefined;
        throw error;
      });
    }
    await this.connectPromise;
  }

  async listTools(): Promise<McpToolInfo[]> {
    return this.guard(async () => {
      await this.connect();
      const listed = await this.client!.listTools();
      const secrets = this.secrets();
      return (listed.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ? redactSecrets(tool.description, secrets) : undefined,
        inputSchema: tool.inputSchema
          ? (redactProtocolTree(tool.inputSchema, secrets) as Record<string, unknown>)
          : undefined,
        readOnlyHint: readOnlyHintOf(tool)
      }));
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    return this.guard(async () => {
      await this.connect();
      const result = await this.client!.callTool({ name, arguments: args });
      const { text, isError } = toolResultToText(
        result as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      );
      return { content: this.redactText(text), isError };
    });
  }

  async listResources(): Promise<McpResourceInfo[]> {
    return this.guard(async () => {
      await this.connect();
      try {
        const listed = await this.client!.listResources();
        const secrets = this.secrets();
        return (listed.resources ?? []).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description ? redactSecrets(resource.description, secrets) : undefined,
          mimeType: resource.mimeType ? redactSecrets(resource.mimeType, secrets) : undefined
        }));
      } catch {
        return [];
      }
    });
  }

  async readResource(uri: string): Promise<{ text: string; mimeType?: string }> {
    return this.guard(async () => {
      await this.connect();
      const listed = await this.client!.readResource({ uri });
      const content = listed.contents?.[0];
      if (!content) return { text: this.redactText(JSON.stringify(listed)) };
      const mimeType = content.mimeType ? this.redactText(content.mimeType) : undefined;
      if ('text' in content && content.text !== undefined) {
        return { text: this.redactText(content.text as string), mimeType };
      }
      if ('blob' in content && typeof content.blob === 'string') {
        return {
          text: this.redactText(`[base64 blob ${content.blob.length} chars]`),
          mimeType
        };
      }
      return { text: this.redactText(JSON.stringify(content)), mimeType };
    });
  }

  async close(): Promise<void> {
    this.connected = false;
    this.connectPromise = undefined;
    const transport = this.transport;
    this.transport = undefined;
    this.client = undefined;
    try {
      await transport?.close();
    } catch {
      /* ignore */
    }
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private secrets(): string[] {
    const headerSecrets = collectHeaderSecrets(this.endpoint, this.env()).secrets;
    const oauthSecrets = this.oauthProvider?.credentialSecrets() ?? [];
    return [...new Set([...headerSecrets, ...oauthSecrets])].sort((a, b) => b.length - a.length);
  }

  private redactText(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  private redact(error: unknown): Error {
    let message = this.redactText(error instanceof Error ? error.message : String(error));
    const authorizationUrl = this.oauthProvider?.displayedAuthorizationUrl();
    if (authorizationUrl && !message.includes(authorizationUrl)) {
      message = `${message}\n${MCP_OAUTH_AUTHORIZATION_PREFIX}${authorizationUrl}`;
    }
    const wrapped = new Error(message);
    wrapped.name = error instanceof Error ? error.name : 'Error';
    const code = errorCode(error);
    if (code !== undefined) (wrapped as Error & { code?: number }).code = code;
    return wrapped;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.redact(error);
    }
  }

  private async doConnect(): Promise<void> {
    this.oauthProvider?.clearDisplayedAuthorizationUrl();
    const mode: McpHttpTransport = this.endpoint.transport === 'sse' ? 'sse' : 'streamable-http';
    if (mode === 'sse') {
      try {
        await this.connectWith('sse');
      } catch (error) {
        throw this.redact(error);
      }
      return;
    }
    try {
      await this.connectWith('streamable-http');
    } catch (error) {
      const pinned = this.endpoint.transport === 'streamable-http';
      if (pinned || !isLegacySseEndpointError(error)) throw this.redact(error);
      const status = errorCode(error) ?? 0;
      this.options.onTransportFallback?.({ url: this.endpoint.url, status });
      try {
        await this.connectWith('sse');
      } catch (sseError) {
        throw this.redact(sseError);
      }
    }
  }

  private async ensureOAuth(): Promise<McpOAuthClientProvider> {
    if (!this.oauthProvider) {
      const stateDir = this.options.stateDir?.trim();
      if (!stateDir) throw new Error('MCP OAuth requires a state directory');
      this.oauthProvider = new McpOAuthClientProvider({
        endpoint: this.endpoint,
        stateDir,
        env: this.env()
      });
    }
    await this.oauthProvider.prepare();
    return this.oauthProvider;
  }

  private async connectWith(kind: McpHttpTransport): Promise<void> {
    const headers = buildHeaders(this.endpoint, this.env());
    const provider = this.endpoint.oauth ? await this.ensureOAuth() : undefined;
    if (provider) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') delete headers[key];
      }
    }
    const fetchImpl = fetchWithTimeout(this.options.fetch ?? fetch, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const url = new URL(this.endpoint.url);
    const requestInit: RequestInit = { headers };
    const auth = provider ? { authProvider: provider } : {};
    const transport =
      kind === 'sse'
        ? new SSEClientTransport(url, { requestInit, fetch: fetchImpl, ...auth })
        : new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchImpl, ...auth });
    const client = new Client({ name: 'raw-agent', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    this.transport = transport;
    this.connected = true;
  }
}
