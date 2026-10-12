/**
 * Playwright browser backend. Fail-soft with a structured error — never fake success.
 */

import { fenceExternalContent } from '../safety/external-content.js';
import type { RunContext, ToolExecutionResult } from '../types.js';
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
    launch: (opts?: { headless?: boolean }) => Promise<PlaywrightBrowser>;
  };
};

type PlaywrightBrowser = {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
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
};

type SessionSlot = { browser: PlaywrightBrowser; page: PlaywrightPage };

const sessions = new Map<string, SessionSlot>();

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
  try {
    const pw = await loadPlaywright();
    if (!pw) {
      return { ok: false, detail: 'playwright 模块未安装', hint: BROWSER_INSTALL_HINT };
    }
    const browser = await pw.chromium.launch({ headless: true });
    await browser.close();
    return { ok: true, detail: 'Playwright Chromium 可用' };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      hint: BROWSER_INSTALL_HINT
    };
  }
}

type PlaywrightLoader = () => Promise<PlaywrightModule | null>;

let playwrightLoaderOverride: PlaywrightLoader | undefined;

/** Test-only: force missing / fake Playwright without touching env. */
export function setPlaywrightLoaderForTests(loader?: PlaywrightLoader): void {
  playwrightLoaderOverride = loader;
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

async function ensurePage(sessionId: string): Promise<SessionSlot> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const pw = await loadPlaywright();
  if (!pw) {
    const err = new Error('playwright_missing');
    err.name = 'browser_not_installed';
    throw err;
  }
  try {
    const browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const slot = { browser, page };
    sessions.set(sessionId, slot);
    return slot;
  } catch (e) {
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

export async function playwrightBrowserAction(
  context: RunContext,
  action: BrowserAction
): Promise<ToolExecutionResult> {
  try {
    const slot = await ensurePage(context.session.id);
    const page = slot.page;
    switch (action.kind) {
      case 'navigate': {
        const url = String(action.url ?? '').trim();
        if (!url) {
          return { ok: false, content: formatBrowserError('browser_action_failed', 'url 必填', action) };
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return {
          ok: true,
          content: formatBrowserNavigateResult(page.url(), await page.title())
        };
      }
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
    if (name === 'browser_launch_failed' || /Executable doesn't exist|browserType.launch/i.test(message)) {
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
    await slot.browser.close();
  } catch {
    /* ignore */
  }
}
