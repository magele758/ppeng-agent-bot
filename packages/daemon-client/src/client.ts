import { feedSseBuffer } from './sse.js';

export interface DaemonClientOptions {
  /** 完整 base URL（含协议），优先于 host/port env 推导。 */
  baseUrl?: string;
  /** 显式指定 Bearer token；未提供时读取 `env.RAW_AGENT_AUTH_TOKEN`。 */
  authToken?: string;
  /** 覆盖用于解析 env 的 process.env，主要供测试使用。 */
  env?: NodeJS.ProcessEnv;
  /** 覆盖全局 fetch，主要供测试使用。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 37070;

export function resolveDaemonBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.RAW_AGENT_DAEMON_BASE_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const host = String(env.RAW_AGENT_DAEMON_HOST ?? '').trim() || DEFAULT_HOST;
  const port = Number(env.RAW_AGENT_DAEMON_PORT ?? DEFAULT_PORT);
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_PORT}`;
}

export class DaemonError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 共享的 daemon HTTP 客户端：封装 base URL 推导、可选 Bearer 鉴权、JSON request、
 * 以及 SSE 流式解析。供 CLI / 未来其他 Node 端消费方复用，避免各自手搓一份 fetch 封装。
 */
export class DaemonClient {
  readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DaemonClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (options.baseUrl ?? resolveDaemonBaseUrl(env)).replace(/\/$/, '');
    this.authToken = (options.authToken ?? String(env.RAW_AGENT_AUTH_TOKEN ?? '')).trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 底层 fetch：补齐 base URL + Bearer，保留原始 Response（用于自定义解析或流式读取）。 */
  async requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    if (this.authToken && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.authToken}`);
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)
        ? ` (daemon not listening? start with: pnpm run start:daemon or pnpm run start:supervised → ${this.baseUrl})`
        : '';
      throw new Error(`${message}${hint}`);
    }
  }

  /** JSON in / JSON out；非 2xx 抛出 DaemonError（附带响应体，方便调用方定制提示）。 */
  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('content-type') && init.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.requestRaw(path, { ...init, headers });
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { _raw: text };
      }
    }
    if (!response.ok) {
      const errorField =
        data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : undefined;
      throw new DaemonError(
        errorField ?? `Daemon request failed with ${response.status}: ${text}`,
        response.status,
        data
      );
    }
    return data as T;
  }

  /**
   * POST（或其他方法）并逐块解析 SSE 响应，对齐 daemon `sseSend` 的 `event:`/`data:` 帧格式。
   * `onEvent` 按到达顺序同步回调，直到流结束。
   */
  async stream(
    path: string,
    init: RequestInit,
    onEvent: (event: string, payload: unknown) => void
  ): Promise<void> {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('content-type') && init.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    if (!headers.has('accept')) {
      headers.set('accept', 'text/event-stream');
    }
    const response = await this.requestRaw(path, { ...init, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new DaemonError(`Daemon stream failed with ${response.status}: ${text}`, response.status);
    }
    if (!response.body) {
      throw new Error('No response body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = feedSseBuffer(buf, value, decoder, onEvent);
    }
  }
}

export function createDaemonClient(options?: DaemonClientOptions): DaemonClient {
  return new DaemonClient(options);
}
