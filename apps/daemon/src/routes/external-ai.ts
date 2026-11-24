import {
  detectLocalCodingAgents,
  hasPersistedExternalAiSettings,
  resolveExternalAiSettings,
  writeExternalAiSettings,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

function configSource(
  runtime: Pick<RawAgentRuntime, 'store'>,
  env: NodeJS.ProcessEnv
): 'lab' | 'env' | 'default' {
  if (hasPersistedExternalAiSettings(runtime.store)) return 'lab';
  const raw = env.RAW_AGENT_EXTERNAL_AI_TOOLS?.trim();
  return raw ? 'env' : 'default';
}

export function externalAiRoutes(
  runtime: Pick<RawAgentRuntime, 'store' | 'syncExternalAiTools'>,
  env: NodeJS.ProcessEnv = process.env
): RouteSpec[] {
  const payload = () => {
    const settings = resolveExternalAiSettings(runtime.store, env);
    const detectedAgents = detectLocalCodingAgents(env);
    return {
      settings,
      persisted: hasPersistedExternalAiSettings(runtime.store),
      detectedAgents,
      effective: {
        source: configSource(runtime, env),
        applyAt: 'next-step',
        detectedAgents
      }
    };
  };

  return [
    {
      method: 'GET',
      pattern: '/api/external-ai/settings',
      handler: ({ response }) => {
        json(response, 200, payload());
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/external-ai/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        writeExternalAiSettings(runtime.store, body, env);
        runtime.syncExternalAiTools();
        json(response, 200, payload());
      }
    }
  ];
}
