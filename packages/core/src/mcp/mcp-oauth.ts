/**
 * MCP OAuth 2.1 + PKCE client for one HTTP endpoint.
 *
 * Tokens, dynamic client registration, and the PKCE verifier live under
 * `<stateDir>/mcp-oauth/`, bucketed by endpoint URL. They are not written to
 * logs or traces. `redirectToAuthorization` records the authorization URL and
 * does not open a browser.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AppError, ValidationError } from '../errors.js';
import type { McpHttpEndpoint } from './mcp-http-config.js';
import { redactSecrets } from './mcp-redact.js';

/** Matches `MIN_CREDENTIAL_LENGTH` in mcp-http.ts. Kept local to avoid an import cycle. */
const MIN_SECRET_LENGTH = 8;

/** Prepended to a connect error when the user must finish authorization. */
export const MCP_OAUTH_AUTHORIZATION_PREFIX = 'MCP OAuth authorization required: ';

const STATE_TTL_MS = 10 * 60 * 1000;
const ROOT_DIR = 'mcp-oauth';
const SENSITIVE_QUERY = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'code_verifier',
  'client_secret',
  'token',
  'code'
]);

interface EndpointRecord {
  url: string;
  redirectUrl: string;
  scope?: string;
  clientId?: string;
  clientSecretEnv?: string;
}

interface PendingAuth {
  state: string;
  authorizationUrl: string;
  createdAt: number;
}

interface StateIndex {
  bucket: string;
  state: string;
}

export interface McpOAuthProviderOptions {
  endpoint: McpHttpEndpoint;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}

export interface McpOAuthFinishInput {
  stateDir: string;
  code: string;
  state: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export interface McpOAuthFinishResult {
  endpointUrl: string;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isBucket(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function redactCredentialText(text: string, secrets: string[]): string {
  return redactSecrets(text, secrets);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function mcpOAuthRedirectUrl(env: NodeJS.ProcessEnv, configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  const rawHost = (env.RAW_AGENT_DAEMON_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = (env.RAW_AGENT_DAEMON_PORT ?? '37070').trim() || '37070';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  const loopback = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${loopback}:${port}/api/mcp/oauth/callback`;
}

/** Drop credential query params before the URL is shown on a connect error. */
export function authorizationUrlForOperator(input: URL): string {
  const url = new URL(input.href);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.toString();
}

function bucketFor(endpointUrl: string): string {
  return sha256(endpointUrl.trim());
}

class McpOAuthFiles {
  constructor(private readonly stateDir: string, private readonly bucket: string) {}

  root(): string {
    return join(this.stateDir, ROOT_DIR);
  }

  serverDir(): string {
    return join(this.root(), 'servers', this.bucket);
  }

  private statePath(state: string): string {
    return join(this.root(), 'states', `${sha256(state)}.json`);
  }

  private async writePrivate(path: string, data: string): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
      await chmod(path, 0o600);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw new Error('MCP OAuth state is unreadable');
    }
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    const text = await this.readText(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('MCP OAuth state is unreadable');
    }
  }

  async writeEndpoint(record: EndpointRecord): Promise<void> {
    await this.writePrivate(join(this.serverDir(), 'endpoint.json'), JSON.stringify(record));
  }

  async readEndpoint(): Promise<EndpointRecord | undefined> {
    const record = await this.readJson<EndpointRecord>(join(this.serverDir(), 'endpoint.json'));
    if (!record || typeof record.url !== 'string' || typeof record.redirectUrl !== 'string') return undefined;
    return record;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJson<OAuthClientInformationMixed>(join(this.serverDir(), 'client.json'));
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.writePrivate(join(this.serverDir(), 'client.json'), JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = await this.readJson<OAuthTokens>(join(this.serverDir(), 'tokens.json'));
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) return undefined;
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.writePrivate(join(this.serverDir(), 'tokens.json'), JSON.stringify(tokens));
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.writePrivate(join(this.serverDir(), 'verifier'), verifier);
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.readText(join(this.serverDir(), 'verifier')))?.trim();
    if (!value) throw new Error('Missing PKCE code verifier');
    return value;
  }

  async saveDiscovery(state: OAuthDiscoveryState): Promise<void> {
    await this.writePrivate(join(this.serverDir(), 'discovery.json'), JSON.stringify(state));
  }

  async discovery(): Promise<OAuthDiscoveryState | undefined> {
    return this.readJson<OAuthDiscoveryState>(join(this.serverDir(), 'discovery.json'));
  }

  async rememberState(state: string): Promise<void> {
    const index: StateIndex = { bucket: this.bucket, state };
    await this.writePrivate(this.statePath(state), JSON.stringify(index));
    const pending: PendingAuth = { state, authorizationUrl: '', createdAt: Date.now() };
    await this.writePrivate(join(this.serverDir(), 'pending.json'), JSON.stringify(pending));
  }

  async saveAuthorizationUrl(authorizationUrl: string): Promise<void> {
    const pending = await this.readJson<PendingAuth>(join(this.serverDir(), 'pending.json'));
    if (!pending || typeof pending.state !== 'string') return;
    const next: PendingAuth = { ...pending, authorizationUrl };
    await this.writePrivate(join(this.serverDir(), 'pending.json'), JSON.stringify(next));
  }

  async deleteState(state: string): Promise<void> {
    await rm(this.statePath(state), { force: true });
  }

  async clearPending(): Promise<void> {
    const pending = await this.readJson<PendingAuth>(join(this.serverDir(), 'pending.json'));
    if (pending && typeof pending.state === 'string' && pending.state) {
      await this.deleteState(pending.state);
    }
    await rm(join(this.serverDir(), 'pending.json'), { force: true });
  }

  async invalidate(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const files: Record<'client' | 'tokens' | 'verifier' | 'discovery', string> = {
      client: 'client.json',
      tokens: 'tokens.json',
      verifier: 'verifier',
      discovery: 'discovery.json'
    };
    const scopes = scope === 'all' ? (Object.keys(files) as Array<keyof typeof files>) : [scope];
    for (const item of scopes) {
      await rm(join(this.serverDir(), files[item]), { force: true });
    }
  }

  credentialSecrets(): string[] {
    const values: string[] = [];
    const remember = (value: unknown) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed.length >= MIN_SECRET_LENGTH) values.push(trimmed);
    };
    for (const name of ['tokens.json', 'client.json']) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.serverDir(), name), 'utf8')) as Record<string, unknown>;
        remember(parsed.access_token);
        remember(parsed.refresh_token);
        remember(parsed.id_token);
        remember(parsed.client_secret);
      } catch {
        /* missing or unreadable: redaction skips it */
      }
    }
    try {
      remember(readFileSync(join(this.serverDir(), 'verifier'), 'utf8'));
    } catch {
      /* no verifier yet */
    }
    return [...new Set(values)];
  }
}

async function locatePending(stateDir: string, state: string): Promise<{ bucket: string } | undefined> {
  const indexPath = join(stateDir, ROOT_DIR, 'states', `${sha256(state)}.json`);
  let text: string;
  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new ValidationError('invalid oauth state');
  }
  let index: StateIndex;
  try {
    index = JSON.parse(text) as StateIndex;
  } catch {
    throw new ValidationError('invalid oauth state');
  }
  if (!index || typeof index.bucket !== 'string' || !isBucket(index.bucket) || typeof index.state !== 'string') {
    return undefined;
  }
  if (!safeEqual(index.state, state)) return undefined;
  const files = new McpOAuthFiles(stateDir, index.bucket);
  let pendingText: string;
  try {
    pendingText = await readFile(join(files.serverDir(), 'pending.json'), 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new ValidationError('invalid oauth state');
  }
  let pending: PendingAuth;
  try {
    pending = JSON.parse(pendingText) as PendingAuth;
  } catch {
    throw new ValidationError('invalid oauth state');
  }
  if (!pending || typeof pending.state !== 'string' || !safeEqual(pending.state, state)) return undefined;
  if (typeof pending.createdAt !== 'number' || Date.now() - pending.createdAt > STATE_TTL_MS) {
    await files.clearPending();
    return undefined;
  }
  return { bucket: index.bucket };
}

function endpointFromRecord(record: EndpointRecord): McpHttpEndpoint {
  const endpoint: McpHttpEndpoint = {
    url: record.url,
    oauth: true,
    oauthRedirectUrl: record.redirectUrl
  };
  if (record.scope) endpoint.oauthScope = record.scope;
  if (record.clientId) endpoint.oauthClientId = record.clientId;
  if (record.clientSecretEnv) endpoint.oauthClientSecretEnv = record.clientSecretEnv;
  return endpoint;
}

function endpointRecord(endpoint: McpHttpEndpoint, env: NodeJS.ProcessEnv): EndpointRecord {
  const record: EndpointRecord = {
    url: endpoint.url.trim(),
    redirectUrl: mcpOAuthRedirectUrl(env, endpoint.oauthRedirectUrl)
  };
  const scope = optionalString(endpoint.oauthScope);
  const clientId = optionalString(endpoint.oauthClientId);
  const clientSecretEnv = optionalString(endpoint.oauthClientSecretEnv);
  if (scope) record.scope = scope;
  if (clientId) record.clientId = clientId;
  if (clientSecretEnv) record.clientSecretEnv = clientSecretEnv;
  return record;
}

/**
 * SDK `OAuthClientProvider` backed by the state directory.
 * One instance talks to one MCP server URL.
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly files: McpOAuthFiles;
  private readonly env: NodeJS.ProcessEnv;
  private lastAuthorizationUrl: string | undefined;
  private indexedState: string | undefined;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.env = options.env ?? process.env;
    this.files = new McpOAuthFiles(options.stateDir, bucketFor(options.endpoint.url));
  }

  /** Persist the non-secret endpoint record so the loopback callback can rebuild this provider. */
  async prepare(): Promise<void> {
    const record = endpointRecord(this.options.endpoint, this.env);
    let redirect: URL;
    try {
      redirect = new URL(record.redirectUrl);
    } catch {
      throw new Error('MCP OAuth redirect URL must be an http(s) URL');
    }
    if (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') {
      throw new Error('MCP OAuth redirect URL must be an http(s) URL');
    }
    record.redirectUrl = redirect.toString();
    await this.files.writeEndpoint(record);
  }

  displayedAuthorizationUrl(): string | undefined {
    return this.lastAuthorizationUrl;
  }

  clearDisplayedAuthorizationUrl(): void {
    this.lastAuthorizationUrl = undefined;
  }

  credentialSecrets(): string[] {
    const values = this.files.credentialSecrets();
    const secret = this.clientSecret();
    if (secret && secret.length >= MIN_SECRET_LENGTH) values.push(secret);
    return [...new Set(values)].sort((a, b) => b.length - a.length);
  }

  get redirectUrl(): string {
    return mcpOAuthRedirectUrl(this.env, this.options.endpoint.oauthRedirectUrl);
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: this.clientSecret() ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'raw-agent'
    };
    const scope = optionalString(this.options.endpoint.oauthScope);
    if (scope) metadata.scope = scope;
    return metadata;
  }

  async state(): Promise<string> {
    if (this.indexedState) await this.files.deleteState(this.indexedState);
    const state = randomBytes(32).toString('base64url');
    this.indexedState = state;
    await this.files.rememberState(state);
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const saved = await this.files.clientInformation();
    if (saved?.client_id) return saved;
    const clientId = optionalString(this.options.endpoint.oauthClientId);
    if (!clientId) return undefined;
    const info: OAuthClientInformationMixed = { client_id: clientId };
    const secret = this.clientSecret();
    if (secret) info.client_secret = secret;
    return info;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.files.saveClientInformation(info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.files.tokens();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.files.saveTokens(tokens);
    await this.files.invalidate('verifier');
    await this.files.clearPending();
    this.lastAuthorizationUrl = undefined;
  }

  /**
   * Record the authorization URL for the connect error. Does not open a browser.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const safe = authorizationUrlForOperator(authorizationUrl);
    this.lastAuthorizationUrl = safe;
    await this.files.saveAuthorizationUrl(safe);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.files.saveCodeVerifier(codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    return this.files.codeVerifier();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.files.saveDiscovery(state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const saved = await this.files.discovery();
    if (!saved || typeof saved.authorizationServerUrl !== 'string' || !saved.authorizationServerUrl) return undefined;
    return saved;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.files.invalidate(scope);
  }

  private clientSecret(): string | undefined {
    const name = optionalString(this.options.endpoint.oauthClientSecretEnv);
    if (!name) return undefined;
    const value = this.env[name]?.trim();
    return value || undefined;
  }
}

/**
 * Exchange the loopback `code` for tokens via `StreamableHTTPClientTransport.finishAuth`.
 * `state` must match the value stored for this endpoint. The result never includes tokens.
 */
export async function finishMcpHttpOAuth(input: McpOAuthFinishInput): Promise<McpOAuthFinishResult> {
  const code = input.code.trim();
  const state = input.state.trim();
  if (!code || !state) throw new ValidationError('code and state are required');
  const located = await locatePending(input.stateDir, state);
  if (!located) throw new ValidationError('invalid oauth state');
  const files = new McpOAuthFiles(input.stateDir, located.bucket);
  const record = await files.readEndpoint();
  if (!record) throw new ValidationError('invalid oauth state');
  const provider = new McpOAuthClientProvider({
    endpoint: endpointFromRecord(record),
    stateDir: input.stateDir,
    env: input.env ?? process.env
  });
  await provider.prepare();
  const transport = new StreamableHTTPClientTransport(new URL(record.url), {
    authProvider: provider,
    fetch: input.fetch
  });
  try {
    await transport.finishAuth(code);
  } catch (error) {
    const secrets = provider.credentialSecrets();
    if (code.length >= MIN_SECRET_LENGTH) secrets.push(code);
    if (state.length >= MIN_SECRET_LENGTH) secrets.push(state);
    const message = redactCredentialText(error instanceof Error ? error.message : String(error), secrets);
    throw new AppError('MCP_OAUTH_EXCHANGE_FAILED', message, 502);
  } finally {
    await transport.close().catch(() => undefined);
  }
  return { endpointUrl: record.url };
}
