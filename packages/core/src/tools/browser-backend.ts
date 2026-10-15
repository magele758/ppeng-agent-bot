/**
 * Playwright browser backend. Fail-soft with a structured error — never fake success.
 *
 * Each session keeps a persistent Chromium profile so cookies survive the next launch.
 * Profiles live under stateDir/browser-profiles (or RAW_AGENT_BROWSER_PROFILE_DIR).
 * Do not log that directory: it holds cookies and local storage.
 */

import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isPrivateOrReservedIp } from '../goal/run-verify.js';
import { fetchPinnedPublic, PrivateNetworkDenied, type PublicFetchDeps } from '../net/public-fetch.js';
import { fenceExternalContent } from '../safety/external-content.js';
import type { SqliteStateStore } from '../storage.js';
import type { ImagePart, RunContext, ToolExecutionResult } from '../types.js';
import { ingestImageAsset } from '../image-assets.js';
import type { BrowserAction } from './browser-tools.js';

export const BROWSER_INSTALL_HINT =
  '本机安装: npm i -D playwright && npx playwright install chromium（仓库根目录已有 @playwright/test 时可直接 npx playwright install chromium）';

export type BrowserErrorCode =
  | 'browser_not_installed'
  | 'browser_launch_failed'
  | 'browser_action_failed'
  | 'browser_no_page';

export interface BrowserErrorShape {
  error: BrowserErrorCode;
  message: string;
  installHint: string;
  action: BrowserAction;
}

type PlaywrightModule = {
  chromium: {
    launchPersistentContext: (
      userDataDir: string,
      opts?: { headless?: boolean }
    ) => Promise<PlaywrightContext>;
  };
};

type PlaywrightContext = {
  pages: () => PlaywrightPage[];
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightRequest = {
  url: () => string;
  method?: () => string;
  headers?: () => Record<string, string>;
  /** Includes Cookie. `headers()` omits it. */
  allHeaders?: () => Promise<Record<string, string>>;
  postData?: () => string | null;
  isNavigationRequest?: () => boolean;
  resourceType?: () => string;
};

type PlaywrightRoute = {
  request: () => PlaywrightRequest;
  abort: (errorCode?: string) => Promise<void>;
  continue: () => Promise<void>;
  fulfill?: (response: { status?: number; headers?: Record<string, string>; body?: Buffer }) => Promise<void>;
};

type PlaywrightPage = {
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  content: () => Promise<string>;
  locator: (sel: string) => {
    click: (opts?: { timeout?: number }) => Promise<void>;
    fill: (text: string, opts?: { timeout?: number }) => Promise<void>;
    count: () => Promise<number>;
  };
  evaluate: (fn: () => unknown) => Promise<unknown>;
  screenshot?: (opts?: { type?: 'png' | 'jpeg' }) => Promise<Buffer | Uint8Array>;
  route?: (pattern: string, handler: (route: PlaywrightRoute) => Promise<unknown>) => Promise<unknown>;
};

type SessionSlot = { context: PlaywrightContext; page: PlaywrightPage };

const sessions = new Map<string, SessionSlot>();

export interface BrowserNavigationPolicyOptions {
  env?: NodeJS.ProcessEnv;
  /** Every resolved address. One private address denies navigation. Default is system DNS. */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /** Per-address connect deadline for the pinned navigation fetch. Default 10s. */
  connectTimeoutMs?: number;
}

export interface BrowserBackendDeps {
  env?: NodeJS.ProcessEnv;
  /** Persist PNG bytes as a session image asset. Return the asset id only. */
  ingestScreenshot?: (png: Buffer, context: RunContext) => Promise<{ id: string }>;
  resolveHost?: BrowserNavigationPolicyOptions['resolveHost'];
  /** Pinned transport. Default connects to the approved address. */
  request?: PublicFetchDeps['request'];
  /** Per-address connect deadline for pinned navigation. Default 10s. */
  connectTimeoutMs?: number;
}

export function formatBrowserError(code: BrowserErrorCode, message: string, action: BrowserAction): string {
  const body: BrowserErrorShape = {
    error: code,
    message,
    installHint: BROWSER_INSTALL_HINT,
    action
  };
  return JSON.stringify(body, null, 2);
}

export async function probePlaywrightBackend(): Promise<{
  ok: boolean;
  detail: string;
  hint?: string;
}> {
  let dir: string | undefined;
  try {
    const pw = await loadPlaywright();
    if (!pw) {
      return { ok: false, detail: 'playwright 模块未安装', hint: BROWSER_INSTALL_HINT };
    }
    dir = await mkdtemp(join(tmpdir(), 'ppeng-browser-probe-'));
    const context = await pw.chromium.launchPersistentContext(dir, { headless: true });
    await context.close();
    return { ok: true, detail: 'Playwright Chromium 可用' };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      hint: BROWSER_INSTALL_HINT
    };
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* probe dir only; never log its contents */
      }
    }
  }
}

type PlaywrightLoader = () => Promise<PlaywrightModule | null>;

let playwrightLoaderOverride: PlaywrightLoader | undefined;

/** Test-only: force missing / fake Playwright without touching env. */
export function setPlaywrightLoaderForTests(loader?: PlaywrightLoader): void {
  playwrightLoaderOverride = loader;
}

/** Test-only: drop in-memory pages so the next call launches again. */
export async function closeAllBrowserSessionsForTests(): Promise<void> {
  const ids = [...sessions.keys()];
  for (const id of ids) await closeBrowserSession(id);
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (playwrightLoaderOverride) return playwrightLoaderOverride();
  try {
    return (await import('playwright')) as PlaywrightModule;
  } catch {
    try {
      return (await import('playwright-core')) as PlaywrightModule;
    } catch {
      return null;
    }
  }
}

function profileSegment(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'session';
  return cleaned;
}

function isWithin(root: string, target: string): boolean {
  const base = resolve(root);
  const abs = resolve(target);
  if (abs === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return abs.startsWith(prefix);
}

/** Host Chrome/Chromium user-data dirs. Never launch against these. */
function isHostBrowserUserDataDir(dir: string): boolean {
  const abs = resolve(dir);
  const home = homedir();
  const markers = [
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    join(home, 'Library', 'Application Support', 'Chromium'),
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
    join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  ];
  return markers.some((marker) => {
    const root = resolve(marker);
    return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/**
 * Persistent profile directory for one session.
 * Default: `<stateDir>/browser-profiles/<sessionId>`.
 * `RAW_AGENT_BROWSER_PROFILE_DIR` replaces the root, not the session segment.
 */
export function browserProfileDir(
  stateDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.RAW_AGENT_BROWSER_PROFILE_DIR?.trim();
  const root = override ? resolve(override) : resolve(stateDir, 'browser-profiles');
  const dir = join(root, profileSegment(sessionId));
  if (!isWithin(root, dir)) return join(root, 'session');
  return dir;
}

async function ensurePage(context: RunContext, env: NodeJS.ProcessEnv): Promise<SessionSlot> {
  const sessionId = context.session.id;
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const pw = await loadPlaywright();
  if (!pw) {
    const err = new Error('playwright_missing');
    err.name = 'browser_not_installed';
    throw err;
  }
  const userDataDir = browserProfileDir(context.stateDir, sessionId, env);
  if (isHostBrowserUserDataDir(userDataDir)) {
    const err = new Error('refusing to open the host Chrome/Chromium profile');
    err.name = 'browser_launch_failed';
    throw err;
  }
  let browser: PlaywrightContext | undefined;
  try {
    await mkdir(userDataDir, { recursive: true });
    browser = await pw.chromium.launchPersistentContext(userDataDir, { headless: true });
    const open = typeof browser.pages === 'function' ? browser.pages() : [];
    const page = open[0] ?? (await browser.newPage());
    const slot = { context: browser, page };
    sessions.set(sessionId, slot);
    return slot;
  } catch (e) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    const err = new Error(e instanceof Error ? e.message : String(e));
    err.name = 'browser_launch_failed';
    throw err;
  }
}

function snapshotFromHtml(html: string, url: string, title: string): string {
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .slice(0, 40)
    .map((m) => `- link href=${m[1]} text=${String(m[2] ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 80)}`);
  const buttons = [...html.matchAll(/<(button|input)\b[^>]*>/gi)]
    .slice(0, 20)
    .map((m) => `- control ${m[0].slice(0, 120)}`);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  return [`url: ${url}`, `title: ${title}`, 'controls:', ...links, ...buttons, 'text:', text].join('\n');
}

export function formatBrowserNavigateResult(url: string, title: string): string {
  return fenceExternalContent({
    source: 'browser',
    label: 'navigate',
    body: JSON.stringify({ ok: true, action: 'navigate', url, title })
  });
}

function pngBytes(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  throw new Error('screenshot did not return png bytes');
}

function validAssetId(id: string | undefined): string | undefined {
  const trimmed = id?.trim() ?? '';
  if (!trimmed || trimmed.length > 128) return undefined;
  if (!/^[\w.-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

/** Store screenshot bytes with the session image assets. Callers return only the id. */
export async function ingestBrowserScreenshotPng(
  store: SqliteStateStore,
  stateDir: string,
  sessionId: string,
  png: Buffer
): Promise<{ id: string }> {
  const asset = await ingestImageAsset(store, stateDir, {
    sessionId,
    buffer: Buffer.from(png),
    mimeType: 'image/png',
    sourceType: 'upload'
  });
  return { id: asset.id };
}

async function runScreenshot(
  context: RunContext,
  action: BrowserAction,
  page: PlaywrightPage,
  deps: BrowserBackendDeps | undefined
): Promise<ToolExecutionResult> {
  if (!deps?.ingestScreenshot) {
    return { ok: false, content: formatBrowserError('browser_action_failed', '截图入库未配置', action) };
  }
  if (typeof page.screenshot !== 'function') {
    return { ok: false, content: formatBrowserError('browser_action_failed', '当前页面不支持截图', action) };
  }
  const png = pngBytes(await page.screenshot({ type: 'png' }));
  if (png.length === 0) {
    return { ok: false, content: formatBrowserError('browser_action_failed', '截图为空', action) };
  }
  const asset = await deps.ingestScreenshot(png, context);
  const assetId = validAssetId(asset?.id);
  if (!assetId) {
    return { ok: false, content: formatBrowserError('browser_action_failed', '截图资产 id 无效', action) };
  }
  const image: ImagePart = { type: 'image', assetId, mimeType: 'image/png', alt: 'browser screenshot' };
  return {
    ok: true,
    content: JSON.stringify({ ok: true, action: 'screenshot', assetId, mimeType: 'image/png' }),
    images: [image]
  };
}

const PRIVATE_NAVIGATION = '拒绝私网、回环、链路本地或运营商级 NAT 地址';

function privateNetworkAllowed(env: NodeJS.ProcessEnv | undefined): boolean {
  return ['1', 'true', 'yes'].includes(String(env?.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE ?? '').toLowerCase());
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function navigationPolicy(deps?: BrowserBackendDeps): BrowserNavigationPolicyOptions {
  const resolve = deps?.resolveHost ?? defaultResolveHost;
  const cache = new Map<string, readonly string[]>();
  return {
    env: deps?.env ?? process.env,
    connectTimeoutMs: deps?.connectTimeoutMs,
    resolveHost: async (hostname) => {
      const hit = cache.get(hostname);
      if (hit) return hit;
      const found = await resolve(hostname);
      cache.set(hostname, found);
      return found;
    }
  };
}

/** Undefined when navigation may open this URL. file:// is never allowed. */
export async function browserNavigationBlockReason(
  rawUrl: string,
  options?: BrowserNavigationPolicyOptions
): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'URL 无效';
  }
  if (parsed.protocol === 'file:') return '拒绝 file:// 地址';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '仅允许 http(s) 导航';
  if (privateNetworkAllowed(options?.env)) return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) return PRIVATE_NAVIGATION;
  if (isIP(host)) return isPrivateOrReservedIp(host) ? PRIVATE_NAVIGATION : undefined;
  let addresses: readonly string[];
  try {
    addresses = await (options?.resolveHost ?? defaultResolveHost)(host);
  } catch {
    return '域名解析失败，拒绝导航';
  }
  if (addresses.length === 0) return '域名解析失败，拒绝导航';
  if (addresses.some((address) => isPrivateOrReservedIp(address))) return PRIVATE_NAVIGATION;
  return undefined;
}

export async function refuseBrowserNavigate(
  rawUrl: string,
  options?: BrowserNavigationPolicyOptions
): Promise<ToolExecutionResult | undefined> {
  const url = String(rawUrl ?? '').trim();
  const action: BrowserAction = { kind: 'navigate', url };
  if (!url) return { ok: false, content: formatBrowserError('browser_action_failed', 'url 必填', action) };
  const reason = await browserNavigationBlockReason(url, options);
  if (!reason) return undefined;
  return { ok: false, content: formatBrowserError('browser_action_failed', reason, action) };
}

function isDocumentNavigation(request: PlaywrightRequest): boolean {
  if (typeof request.isNavigationRequest === 'function' && request.isNavigationRequest()) return true;
  if (typeof request.resourceType === 'function' && request.resourceType() === 'document') return true;
  if (typeof request.isNavigationRequest === 'function' || typeof request.resourceType === 'function') return false;
  return true;
}

const BROWSER_PIN_BODY_MAX = 2_000_000;
const SKIP_BROWSER_HEADER = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
/** Wrong after the body is decoded. Chromium splits one set-cookie value on newlines. */
const DROP_PINNED_RESPONSE_HEADER = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

function browserForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value && !SKIP_BROWSER_HEADER.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function browserFulfillHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const cookies = res.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies.join('\n');
  res.headers.forEach((value, key) => {
    if (key === 'set-cookie' || DROP_PINNED_RESPONSE_HEADER.has(key)) return;
    headers[key] = value;
  });
  return headers;
}

async function readPinnedBrowserBody(res: Response): Promise<Buffer | undefined> {
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > BROWSER_PIN_BODY_MAX) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

async function fulfillPinnedBrowserRoute(
  route: PlaywrightRoute,
  policy: BrowserNavigationPolicyOptions,
  request: PublicFetchDeps['request'] | undefined
): Promise<void> {
  const req = route.request();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetchPinnedPublic(req.url(), {
      signal: ctrl.signal,
      method: req.method?.() || 'GET',
      headers: browserForwardHeaders(await req.allHeaders?.()),
      body: req.postData?.() || undefined,
      allowPrivateHosts: false,
      resolveHost: policy.resolveHost,
      request,
      followRedirects: false,
      connectTimeoutMs: policy.connectTimeoutMs
    });
    const buf = await readPinnedBrowserBody(res);
    if (!buf) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill?.({ status: res.status, headers: browserFulfillHeaders(res), body: buf });
  } finally {
    clearTimeout(timer);
  }
}

async function blockBrowserRoute(
  route: PlaywrightRoute,
  policy: BrowserNavigationPolicyOptions,
  onDocumentBlock: (reason: string) => void
): Promise<boolean> {
  const req = route.request();
  let reason: string | undefined;
  try {
    reason = await browserNavigationBlockReason(req.url(), policy);
  } catch {
    reason = PRIVATE_NAVIGATION;
  }
  if (!reason) return false;
  if (isDocumentNavigation(req)) onDocumentBlock(reason);
  await route.abort('blockedbyclient');
  return true;
}

async function abortPinnedBrowserRoute(
  route: PlaywrightRoute,
  error: unknown,
  onDocumentBlock: (reason: string) => void
): Promise<void> {
  const message = error instanceof PrivateNetworkDenied ? error.message : '导航连接失败';
  if (isDocumentNavigation(route.request())) onDocumentBlock(message);
  await route.abort('blockedbyclient');
}

async function settleBrowserRoute(
  route: PlaywrightRoute,
  policy: BrowserNavigationPolicyOptions,
  request: PublicFetchDeps['request'] | undefined,
  onDocumentBlock: (reason: string) => void
): Promise<void> {
  if (await blockBrowserRoute(route, policy, onDocumentBlock)) return;
  if (privateNetworkAllowed(policy.env) || !route.fulfill) {
    await route.continue();
    return;
  }
  try {
    await fulfillPinnedBrowserRoute(route, policy, request);
  } catch (error) {
    await abortPinnedBrowserRoute(route, error, onDocumentBlock);
  }
}

async function completeBrowserNavigate(
  page: PlaywrightPage,
  action: Extract<BrowserAction, { kind: 'navigate' }>,
  policy: BrowserNavigationPolicyOptions,
  request?: PublicFetchDeps['request']
): Promise<ToolExecutionResult> {
  const url = action.url.trim();
  let documentBlocked: string | undefined;
  if (typeof page.route === 'function') {
    await page.route('**/*', (route) =>
      settleBrowserRoute(route, policy, request, (reason) => {
        documentBlocked = reason;
      })
    );
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) {
    if (documentBlocked) {
      return { ok: false, content: formatBrowserError('browser_action_failed', documentBlocked, action) };
    }
    throw error;
  }
  if (documentBlocked) {
    return { ok: false, content: formatBrowserError('browser_action_failed', documentBlocked, action) };
  }
  const landed = page.url();
  const landedReason = await browserNavigationBlockReason(landed, policy);
  if (landedReason) {
    return { ok: false, content: formatBrowserError('browser_action_failed', landedReason, action) };
  }
  return { ok: true, content: formatBrowserNavigateResult(landed, await page.title()) };
}

async function runBrowserNavigate(
  context: RunContext,
  action: Extract<BrowserAction, { kind: 'navigate' }>,
  deps?: BrowserBackendDeps
): Promise<ToolExecutionResult> {
  const policy = navigationPolicy(deps);
  const refused = await refuseBrowserNavigate(action.url, policy);
  if (refused) return refused;
  const slot = await ensurePage(context, deps?.env ?? process.env);
  return completeBrowserNavigate(slot.page, { kind: 'navigate', url: action.url.trim() }, policy, deps?.request);
}

export async function playwrightBrowserAction(
  context: RunContext,
  action: BrowserAction,
  deps?: BrowserBackendDeps
): Promise<ToolExecutionResult> {
  try {
    if (action.kind === 'navigate') return await runBrowserNavigate(context, action, deps);
    const slot = await ensurePage(context, deps?.env ?? process.env);
    const page = slot.page;
    switch (action.kind) {
      case 'snapshot': {
        const html = await page.content();
        const title = await page.title();
        return {
          ok: true,
          content: fenceExternalContent({
            source: 'browser',
            label: page.url(),
            body: snapshotFromHtml(html, page.url(), title)
          })
        };
      }
      case 'screenshot':
        return await runScreenshot(context, action, page, deps);
      case 'click': {
        const loc = page.locator(action.selector);
        if ((await loc.count()) === 0) {
          return {
            ok: false,
            content: formatBrowserError('browser_action_failed', `未找到选择器: ${action.selector}`, action)
          };
        }
        await loc.click({ timeout: 10_000 });
        return { ok: true, content: JSON.stringify({ ok: true, action: 'click', selector: action.selector }, null, 2) };
      }
      case 'type': {
        const loc = page.locator(action.selector);
        if ((await loc.count()) === 0) {
          return {
            ok: false,
            content: formatBrowserError('browser_action_failed', `未找到选择器: ${action.selector}`, action)
          };
        }
        await loc.fill(action.text, { timeout: 10_000 });
        return { ok: true, content: JSON.stringify({ ok: true, action: 'type', selector: action.selector }, null, 2) };
      }
      default: {
        const _never: never = action;
        return { ok: false, content: formatBrowserError('browser_action_failed', `未知动作`, _never) };
      }
    }
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    const message = e instanceof Error ? e.message : String(e);
    if (name === 'browser_not_installed' || /Cannot find module ['"]playwright/.test(message)) {
      return {
        ok: false,
        content: formatBrowserError('browser_not_installed', '未安装 Playwright 或浏览器二进制。' + message, action)
      };
    }
    if (name === 'browser_launch_failed' || /Executable doesn't exist|browserType\.launch/i.test(message)) {
      return {
        ok: false,
        content: formatBrowserError('browser_launch_failed', message, action)
      };
    }
    return { ok: false, content: formatBrowserError('browser_action_failed', message, action) };
  }
}

export async function closeBrowserSession(sessionId: string): Promise<void> {
  const slot = sessions.get(sessionId);
  if (!slot) return;
  sessions.delete(sessionId);
  try {
    await slot.context.close();
  } catch {
    /* ignore */
  }
}
