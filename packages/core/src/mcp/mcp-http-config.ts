export type McpHttpTransport = 'streamable-http' | 'sse';

export interface McpHttpEndpoint {
  url: string;
  headers?: Record<string, string>;
  /** Read at connect time from the process env. Never logged. */
  bearerEnv?: string;
  transport?: McpHttpTransport;
  /**
   * Use OAuth 2.1 + PKCE. The SDK auth provider is attached to the HTTP transport.
   * A static bearer still works when this is omitted. When both are set, the OAuth
   * access token is sent and the static Authorization header is not copied onto the request.
   */
  oauth?: boolean;
  /** Loopback redirect. Defaults to the daemon origin plus `/api/mcp/oauth/callback`. */
  oauthRedirectUrl?: string;
  oauthScope?: string;
  /** Pre-registered client id. Omit to use dynamic client registration. */
  oauthClientId?: string;
  /** Env var name for a pre-registered client secret. The value is never logged. */
  oauthClientSecretEnv?: string;
}

export interface McpHttpConfigParse {
  endpoints: McpHttpEndpoint[];
  /** `RAW_AGENT_MCP_HTTP` was non-empty but not a JSON array. */
  invalidJson: boolean;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function applyOAuth(endpoint: McpHttpEndpoint, record: Record<string, unknown>): void {
  const oauth = record.oauth;
  const nested =
    oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? (oauth as Record<string, unknown>) : undefined;
  if (oauth !== true && !nested) return;
  endpoint.oauth = true;
  const redirect = optionalString(nested?.redirectUrl) ?? optionalString(record.oauthRedirectUrl);
  const scope = optionalString(nested?.scope) ?? optionalString(record.oauthScope);
  const clientId = optionalString(nested?.clientId) ?? optionalString(record.oauthClientId);
  const clientSecretEnv = optionalString(nested?.clientSecretEnv) ?? optionalString(record.oauthClientSecretEnv);
  if (redirect) endpoint.oauthRedirectUrl = redirect;
  if (scope) endpoint.oauthScope = scope;
  if (clientId) endpoint.oauthClientId = clientId;
  if (clientSecretEnv) endpoint.oauthClientSecretEnv = clientSecretEnv;
}

function hasAuthorization(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

function parseLegacyUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RAW_AGENT_MCP_URLS ?? env.RAW_AGENT_MCP_URL ?? '';
  return raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Comma-aligned with the legacy URL list. Commas only — tokens are not split on spaces. */
function parseLegacyBearers(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RAW_AGENT_MCP_BEARER ?? '';
  if (!raw.trim()) return [];
  return raw.split(',').map((part) => part.trim());
}

function parseJsonEndpoints(raw: string): { endpoints: McpHttpEndpoint[]; invalidJson: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { endpoints: [], invalidJson: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { endpoints: [], invalidJson: true };
  }
  if (!Array.isArray(parsed)) return { endpoints: [], invalidJson: true };
  const endpoints: McpHttpEndpoint[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) continue;
    const headers = stringRecord(record.headers);
    const bearerEnv = typeof record.bearerEnv === 'string' ? record.bearerEnv.trim() : '';
    const transport =
      record.transport === 'sse' || record.transport === 'streamable-http' ? record.transport : undefined;
    const endpoint: McpHttpEndpoint = { url };
    if (headers) endpoint.headers = headers;
    if (bearerEnv) endpoint.bearerEnv = bearerEnv;
    if (transport) endpoint.transport = transport;
    applyOAuth(endpoint, record);
    endpoints.push(endpoint);
  }
  return { endpoints, invalidJson: false };
}

function withBearer(endpoint: McpHttpEndpoint, token: string | undefined): McpHttpEndpoint {
  if (!token || endpoint.bearerEnv || hasAuthorization(endpoint.headers)) return endpoint;
  return {
    ...endpoint,
    headers: { ...endpoint.headers, Authorization: `Bearer ${token}` }
  };
}

/**
 * JSON endpoints from `RAW_AGENT_MCP_HTTP` come first. Legacy `RAW_AGENT_MCP_URLS` /
 * `RAW_AGENT_MCP_URL` entries are appended when the URL is not already present.
 * `RAW_AGENT_MCP_BEARER` is comma-aligned with the legacy URL list and copied only
 * when that endpoint has neither `Authorization` nor `bearerEnv`.
 */
export function parseMcpHttpConfig(env: NodeJS.ProcessEnv): McpHttpConfigParse {
  const json = parseJsonEndpoints(env.RAW_AGENT_MCP_HTTP ?? '');
  const legacyUrls = parseLegacyUrls(env);
  const bearers = parseLegacyBearers(env);
  const bearerByUrl = new Map<string, string>();
  legacyUrls.forEach((url, index) => {
    const token = bearers[index];
    if (token && !bearerByUrl.has(url)) bearerByUrl.set(url, token);
  });

  const endpoints = json.endpoints.map((endpoint) => withBearer(endpoint, bearerByUrl.get(endpoint.url)));
  const seen = new Set(endpoints.map((endpoint) => endpoint.url));
  legacyUrls.forEach((url, index) => {
    if (seen.has(url)) return;
    seen.add(url);
    endpoints.push(withBearer({ url }, bearers[index]));
  });
  return { endpoints, invalidJson: json.invalidJson };
}

export function parseMcpHttpEndpoints(env: NodeJS.ProcessEnv): McpHttpEndpoint[] {
  return parseMcpHttpConfig(env).endpoints;
}
