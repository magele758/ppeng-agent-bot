/**
 * GET/PATCH /api/langfuse/settings — Lab KV. No export unless entry saved and enabled.
 * POST /api/langfuse/probe — connectivity check; does not turn export on.
 */

import {
  publicLangfuseSettings,
  readLangfuseSettings,
  readLangfuseDelivery,
  writeLangfuseSettings,
  probeLangfuse,
  type LangfuseSettingsPatch,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function langfuseRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/langfuse/settings',
      handler: ({ response }) => {
        const settings = publicLangfuseSettings(readLangfuseSettings(runtime.store), process.env);
        json(response, 200, {
          settings,
          effective: {
            source: runtime.store.getDaemonControl('langfuse_settings') ? 'ui' : 'default',
            delivery: readLangfuseDelivery(runtime.store)
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/langfuse/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as LangfuseSettingsPatch;
        const saved = writeLangfuseSettings(runtime.store, body ?? {});
        json(response, 200, {
          settings: publicLangfuseSettings(saved, process.env),
          effective: { source: 'ui' as const, delivery: readLangfuseDelivery(runtime.store) }
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/langfuse/probe',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as LangfuseSettingsPatch;
        const saved = readLangfuseSettings(runtime.store);
        const baseUrl = (
          typeof body?.baseUrl === 'string' ? body.baseUrl : saved.baseUrl
        )
          .trim()
          .replace(/\/+$/, '');
        if (!baseUrl) {
          json(response, 200, { ok: false, error: 'baseUrl required' });
          return;
        }
        const publicKey =
          typeof body?.publicKey === 'string' && body.publicKey.trim()
            ? body.publicKey.trim()
            : saved.publicKey || (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
        const secretKey =
          typeof body?.secretKey === 'string' && body.secretKey.trim()
            ? body.secretKey.trim()
            : saved.secretKey || (process.env.LANGFUSE_SECRET_KEY || '').trim();
        const result = await probeLangfuse({ baseUrl, publicKey, secretKey });
        json(response, 200, result);
      }
    }
  ];
}
