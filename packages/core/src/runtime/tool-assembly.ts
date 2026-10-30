/**
 * Optional extra tools (browser / cron / discovery / tailscale) assembled at runtime start.
 */

import { routineSettings, type RoutineRuntimeHost } from '../cron/routine-runtime.js';
import { CronJobStore, createCronTools } from '../cron/cron-store.js';
import { CapabilityRegistry } from '../discovery/registry.js';
import type { SqliteStateStore } from '../storage.js';
import { createTailscaleTools } from '../tools/tailscale-tools.js';
import { createDurablePagePort } from '../library/durable-page-port.js';
import { createPageTools } from '../tools/page-tools.js';
import { createVaultTools } from '../tools/vault-tools.js';
import type { UserVault } from '../secrets/user-vault.js';
import { readUserVaultSettings } from '../secrets/user-vault-settings.js';
import {
  DISCLOSED_TOOL_NAMES_META,
  readDisclosedToolNames
} from '../tools/deferred-disclosure.js';
import { createToolSearchTools } from '../tools/tool-search.js';
import { ingestBrowserScreenshotPng } from '../tools/browser-backend.js';
import { createBrowserTools, defaultBrowserAction } from '../tools/browser-tools.js';
import { resolveBrowserToolsEnabled } from '../tools/browser-settings.js';
import type { ToolContract } from '../types.js';

function discloseOnDemandTool(store: SqliteStateStore, sessionId: string, name: string): void {
  const session = store.getSession(sessionId);
  if (!session || !name) return;
  const names = readDisclosedToolNames(session.metadata);
  if (names.includes(name)) return;
  store.updateSession(sessionId, {
    metadata: {
      ...session.metadata,
      [DISCLOSED_TOOL_NAMES_META]: [...names, name]
    }
  });
}

export function assembleOptionalTools(input: {
  env: NodeJS.ProcessEnv;
  store: SqliteStateStore;
  stateDir: string;
  getCronStore: () => CronJobStore;
  getUserVault: () => UserVault;
  routineHost?: RoutineRuntimeHost;
  /** Read when tool_search or load_capability_tool runs, not while assembling. */
  getCatalog?: () => ToolContract<any>[];
}): ToolContract<any>[] {
  const optionalExtras: ToolContract<any>[] = [];
  if (resolveBrowserToolsEnabled(input.store, input.env)) {
    optionalExtras.push(
      ...createBrowserTools({
        runBrowserAction: (ctx, action) =>
          defaultBrowserAction(ctx, action, {
            env: input.env,
            ingestScreenshot: (png, shotCtx) =>
              ingestBrowserScreenshotPng(input.store, input.stateDir, shotCtx.session.id, png)
          })
      })
    );
  }
  optionalExtras.push(...createPageTools({ getPagePort: () => createDurablePagePort(input.store) }));
  optionalExtras.push(
    ...createVaultTools({
      getVault: input.getUserVault,
      isEnabled: () => readUserVaultSettings(input.store).enabled,
      isFillTargetAvailable: () => resolveBrowserToolsEnabled(input.store, input.env),
      fillField: async (ctx, selector, value) =>
        (await defaultBrowserAction(ctx, { kind: 'type', selector, text: value }, { env: input.env })).ok
    })
  );
  optionalExtras.push(...createCronTools(() => input.getCronStore(), {runtimeHost:input.routineHost,store:input.store,isEnabled:()=>routineSettings(input.store).dialogToolsEnabled}));
  {
    const getRegistry = () => new CapabilityRegistry(input.store.capabilities());
    optionalExtras.push(
      ...createToolSearchTools({
        getRegistry,
        getShortlist: (sessionId) => {
          const session = input.store.getSession(sessionId);
          const raw = (session?.metadata as Record<string, unknown> | undefined)
            ?.capabilityShortlist;
          return Array.isArray(raw) ? raw.map(String) : [];
        },
        env: input.env,
        settingsStore: input.store,
        getCatalog: input.getCatalog,
        discloseTool: (sessionId, name) => discloseOnDemandTool(input.store, sessionId, name)
      }),
      ...createTailscaleTools({
        getRegistry,
        env: input.env,
        settingsStore: input.store
      })
    );
  }
  return optionalExtras;
}
