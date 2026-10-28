import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  gatewayConfigPath,
  RUNTIME_CAPABILITIES_KEY,
  readRuntimeCapabilities,
  domainCatalog,
  type RuntimeCapabilities,
  hasPersistedBrowserSettings,
  hasPersistedDiscoverySettings,
  hasPersistedMemorySettings,
  hasPersistedWebSettings,
  readBrowserSettings,
  readDiscoverySettings,
  readMemorySettings,
  readModelCatalog,
  readWebSettings,
  resolveEffectiveConfig,
  type CoreStorageContext,
  type EffectiveConfigInput,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

const EXTERNAL_AI_BINARIES = ['claude', 'codex', 'cursor-agent'] as const;

/** 只看 PATH 上有没有可执行文件；结果仅作提示，绝不据此自动开启能力。 */
export function detectLocalBinaries(env: NodeJS.ProcessEnv): string[] {
  const dirs = String(env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean);
  const found: string[] = [];
  for (const bin of EXTERNAL_AI_BINARIES) {
    const hit = dirs.some((d) => {
      try {
        return statSync(join(d, bin)).isFile();
      } catch {
        return false;
      }
    });
    if (hit) found.push(bin);
  }
  return found;
}

export interface ConfigRoutesDeps {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  storageCtx: CoreStorageContext;
  domainsMounted: string[];
}

export function buildEffectiveConfigInput(runtime: RawAgentRuntime, deps: ConfigRoutesDeps): EffectiveConfigInput {
  const store = runtime.store;
  const catalog = readModelCatalog(store);
  return {
    env: deps.env,
    stateDir: runtime.stateDir,
    lab: {
      runtimeCapabilities: store.getDaemonControl(RUNTIME_CAPABILITIES_KEY) as Partial<RuntimeCapabilities> | undefined,
      webSearch: {
        persisted: hasPersistedWebSettings(store),
        template: readWebSettings(store).searchUrl
      },
      memory: {
        persisted: hasPersistedMemorySettings(store),
        embeddingRecallMode: readMemorySettings(store).embeddingRecallMode
      },
      browser: {
        persisted: hasPersistedBrowserSettings(store),
        enabled: readBrowserSettings(store).enabled
      },
      discovery: {
        persisted: hasPersistedDiscoverySettings(store),
        enabled: readDiscoverySettings(store).enabled
      },
      openAiCompatibleProviderConfigured: catalog.providers.some(
        (p) => p.kind === 'openai-compatible' && p.apiKey.trim() !== '' && p.baseUrl.trim() !== ''
      )
    },
    probes: {
      gatewayConfigExists: existsSync(gatewayConfigPath(deps.repoRoot)),
      localBinaries: detectLocalBinaries(deps.env)
    },
    runtime: {
      storageFallbacks: deps.storageCtx.fallbacks,
      domainsMounted: domainCatalog(store).length ? readRuntimeCapabilities(store, deps.env).domains.filter(id => domainCatalog(store).some(d => d.id === id)) : deps.domainsMounted,
      mcpHttpConnected: runtime.mcpHttpConnectedCount()
    }
  };
}

/**
 * Read-only "what is actually in effect, and why". Never returns secrets or connection strings —
 * only env-var names, counts and short reason codes.
 */
export function configRoutes(runtime: RawAgentRuntime, deps: ConfigRoutesDeps): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/config/effective',
      handler: ({ response }) => {
        json(response, 200, resolveEffectiveConfig(buildEffectiveConfigInput(runtime, deps)));
      }
    }
  ];
}
