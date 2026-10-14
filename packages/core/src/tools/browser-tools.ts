import { envBool } from '../env.js';
import type { ToolContract, RunContext, ToolExecutionResult } from '../types.js';
import { playwrightBrowserAction, refuseBrowserNavigate, type BrowserBackendDeps } from './browser-backend.js';

/**
 * Optional browser tools (Playwright via npx). Gated by optional tool group `browser`
 * and env RAW_AGENT_BROWSER_TOOLS=1. Default off — keeps core schema narrow.
 */

export interface BrowserToolServices {
  /** Run a browser action; implementations may use Playwright CLI or MCP. */
  runBrowserAction: (
    context: RunContext,
    action: BrowserAction
  ) => Promise<ToolExecutionResult>;
}

export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'snapshot' }
  | { kind: 'screenshot' }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string };

export function browserToolsFeatureEnabled(env: NodeJS.ProcessEnv): boolean {
  return envBool(env, 'RAW_AGENT_BROWSER_TOOLS', false);
}

export function createBrowserTools(services: BrowserToolServices): ToolContract<any>[] {
  const navigate: ToolContract<{ url: string }> = {
    name: 'browser_navigate',
    description:
      'Navigate the browser session to a URL (Lab「更多 → 浏览器」或 RAW_AGENT_BROWSER_TOOLS；需本机 Playwright Chromium)。拒绝 file://；默认拒绝私网、回环、链路本地和运营商级 NAT 地址。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    needsApproval: () => true,
    async execute(context, args) {
      const refused = await refuseBrowserNavigate(String(args.url ?? ''), { env: process.env });
      if (refused) return refused;
      return services.runBrowserAction(context, { kind: 'navigate', url: args.url });
    }
  };

  const snapshot: ToolContract<Record<string, never>> = {
    name: 'browser_snapshot',
    description: 'Capture accessibility/text snapshot of the current browser page.',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context) {
      return services.runBrowserAction(context, { kind: 'snapshot' });
    }
  };

  const screenshot: ToolContract<Record<string, never>> = {
    name: 'browser_screenshot',
    description:
      'Capture a PNG of the current page, store it as a session image asset, and return only the asset id (no base64).',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context) {
      return services.runBrowserAction(context, { kind: 'screenshot' });
    }
  };

  const click: ToolContract<{ selector: string }> = {
    name: 'browser_click',
    description: 'Click an element by CSS selector in the browser session.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    needsApproval: () => true,
    async execute(context, args) {
      return services.runBrowserAction(context, { kind: 'click', selector: args.selector });
    }
  };

  const typeTool: ToolContract<{ selector: string; text: string }> = {
    name: 'browser_type',
    description: 'Type text into an element by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['selector', 'text']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    needsApproval: () => true,
    async execute(context, args) {
      return services.runBrowserAction(context, {
        kind: 'type',
        selector: args.selector,
        text: args.text
      });
    }
  };

  return [navigate, snapshot, screenshot, click, typeTool];
}

/** Playwright backend; fail-soft with a structured error when Chromium is missing. */
export async function defaultBrowserAction(
  context: RunContext,
  action: BrowserAction,
  deps?: BrowserBackendDeps
): Promise<ToolExecutionResult> {
  return playwrightBrowserAction(context, action, deps);
}
