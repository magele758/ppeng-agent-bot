import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpHttpEndpoint, McpHttpTransport } from './mcp-http-config.js';
import type { McpResourceInfo, McpToolInfo } from './mcp-jsonrpc.js';

const DEFAULT_TIMEOUT_MS = 20_000;

export interface McpHttpSessionOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Fired when an unpinned Streamable HTTP connect falls back to legacy SSE. */
  onTransportFallback?: (info: { url: string; status: number }) => void;
}

interface ResolvedHeaders {
  headers: Record<string, string>;
  secrets: string[];
}

function resolveHeaders(endpoint: McpHttpEndpoint, env: NodeJS.ProcessEnv): ResolvedHeaders {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(endpoint.headers ?? {})) {
    if (value) headers[key] = value;
  }
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuth && endpoint.bearerEnv) {
    const token = env[endpoint.bearerEnv]?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const secrets: string[] = [];
  for (const value of Object.values(headers)) {
    secrets.push(value);
    const match = /^Bearer\s+(\S+)/i.exec(value);
    if (match?.[1]) secrets.push(match[1]);
  }
  return { headers, secrets };
}

export function redactSecrets(text: string, secrets: string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of unique) {
    out = out.split(secret).join('[REDACTED]');
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
      return (listed.tools ?? []).map((tool) =>
        this.redactDeep({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          readOnlyHint: readOnlyHintOf(tool)
        })
      );
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
        return this.redactDeep(
          (listed.resources ?? []).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType
          }))
        );
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
      if ('text' in content && content.text !== undefined) {
        return { text: this.redactText(content.text as string), mimeType: content.mimeType };
      }
      if ('blob' in content && typeof content.blob === 'string') {
        return {
          text: this.redactText(`[base64 blob ${content.blob.length} chars]`),
          mimeType: content.mimeType
        };
      }
      return { text: this.redactText(JSON.stringify(this.redactDeep(content))), mimeType: content.mimeType };
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
    return resolveHeaders(this.endpoint, this.env()).secrets;
  }

  private redactText(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  private redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redactText(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.redactDeep(child);
      }
      return out as T;
    }
    return value;
  }

  private redact(error: unknown): Error {
    const message = this.redactText(error instanceof Error ? error.message : String(error));
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

  private async connectWith(kind: McpHttpTransport): Promise<void> {
    const { headers } = resolveHeaders(this.endpoint, this.env());
    const fetchImpl = fetchWithTimeout(this.options.fetch ?? fetch, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const url = new URL(this.endpoint.url);
    const requestInit: RequestInit = { headers };
    const transport =
      kind === 'sse'
        ? new SSEClientTransport(url, { requestInit, fetch: fetchImpl })
        : new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchImpl });
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
