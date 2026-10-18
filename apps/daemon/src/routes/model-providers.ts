/**
 * Lab model providers: configure base URL + API key, scan /v1/models, pick in chat.
 * GET/POST/PATCH/DELETE /api/model-providers
 * POST /api/model-providers/preview-scan
 * POST /api/model-providers/:id/scan
 * Persisted in daemon_control KV. No new RAW_AGENT_* switches.
 */

import {
  NotFoundError,
  ValidationError,
  deleteProvider,
  listRemoteModels,
  mergeScannedModels,
  parseModelRef,
  parseProviderKind,
  parseThinkingMode,
  patchCatalogRouting,
  patchProvider,
  publicCatalogPayload,
  publicProvider,
  readModelCatalog,
  setCatalogDefaultRef,
  suggestProviderName,
  upsertProvider,
  type ModelProviderPatch,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function modelProviderRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/model-providers',
      handler: ({ response }) => {
        json(response, 200, publicCatalogPayload(runtime.store, process.env));
      }
    },
    {
      method: 'POST',
      pattern: '/api/model-providers',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const kind = parseProviderKind(body.kind) ?? 'openai-compatible';
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        const nameRaw = typeof body.name === 'string' ? body.name.trim() : '';
        const name = nameRaw || suggestProviderName(baseUrl, kind);
        if (kind !== 'heuristic') {
          if (!baseUrl) throw new ValidationError('baseUrl is required');
          if (!apiKey) throw new ValidationError('apiKey is required');
        }
        const provider = upsertProvider(runtime.store, {
          name,
          kind,
          baseUrl,
          apiKey,
          useJsonMode: body.useJsonMode !== false,
          httpKind: typeof body.httpKind === 'string' ? (body.httpKind as 'chat_completions' | 'responses') : undefined,
          models: Array.isArray(body.models) ? (body.models as ModelProviderPatch['models']) : undefined
        });
        json(response, 201, {
          provider: publicProvider(provider, 'ui'),
          ...publicCatalogPayload(runtime.store, process.env)
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/model-providers/preview-scan',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const kind = parseProviderKind(body.kind) ?? 'openai-compatible';
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (kind === 'heuristic') {
          json(response, 200, {
            ok: true,
            models: [{ id: 'heuristic' }],
            endpoint: '',
            suggestedName: suggestProviderName(baseUrl, kind)
          });
          return;
        }
        try {
          const listed = await listRemoteModels({ kind, baseUrl, apiKey });
          json(response, 200, {
            ok: true,
            models: listed.models,
            endpoint: listed.endpoint,
            suggestedName: suggestProviderName(baseUrl, kind)
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          json(response, 200, {
            ok: false,
            error: message,
            models: [],
            suggestedName: suggestProviderName(baseUrl, kind)
          });
        }
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/model-providers/routing',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const thinkingMode =
          body.thinkingMode === null ? null : parseThinkingMode(body.thinkingMode);
        if (body.thinkingMode != null && body.thinkingMode !== null && !thinkingMode) {
          throw new ValidationError('thinkingMode must be on|off|auto');
        }
        let fallbackRefs: Array<{ providerId: string; modelId: string }> | null | undefined;
        if (body.fallbackRefs === null) fallbackRefs = null;
        else if (Array.isArray(body.fallbackRefs)) {
          fallbackRefs = [];
          for (const item of body.fallbackRefs) {
            const ref = parseModelRef(item);
            if (ref) fallbackRefs.push(ref);
          }
        }
        patchCatalogRouting(runtime.store, { thinkingMode, fallbackRefs });
        json(response, 200, publicCatalogPayload(runtime.store, process.env));
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/model-providers/default',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const ref =
          body.defaultRef === null ? null : parseModelRef(body.defaultRef) ?? parseModelRef(body);
        if (body.defaultRef !== null && !ref) {
          throw new ValidationError('defaultRef.providerId and defaultRef.modelId are required');
        }
        setCatalogDefaultRef(runtime.store, ref ?? null);
        json(response, 200, publicCatalogPayload(runtime.store, process.env));
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/model-providers/:id',
      handler: async ({ requireParam, readBody, response }) => {
        const id = requireParam('id');
        const body = (await readBody()) as Record<string, unknown>;
        const patch: ModelProviderPatch = {};
        if (typeof body.name === 'string') patch.name = body.name;
        const kind = parseProviderKind(body.kind);
        if (kind) patch.kind = kind;
        if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl;
        if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey;
        if (typeof body.useJsonMode === 'boolean') patch.useJsonMode = body.useJsonMode;
        if (body.httpKind === null) patch.httpKind = null;
        else if (typeof body.httpKind === 'string') {
          patch.httpKind = body.httpKind as 'chat_completions' | 'responses';
        }
        if (Array.isArray(body.models)) {
          patch.models = body.models as ModelProviderPatch['models'];
        }
        const provider = patchProvider(runtime.store, id, patch);
        if (!provider) throw new NotFoundError('ModelProvider', id);
        json(response, 200, {
          provider: publicProvider(provider, 'ui'),
          ...publicCatalogPayload(runtime.store, process.env)
        });
      }
    },
    {
      method: 'DELETE',
      pattern: '/api/model-providers/:id',
      handler: ({ requireParam, response }) => {
        const id = requireParam('id');
        if (!deleteProvider(runtime.store, id)) throw new NotFoundError('ModelProvider', id);
        json(response, 200, { ok: true, ...publicCatalogPayload(runtime.store, process.env) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/model-providers/:id/scan',
      handler: async ({ requireParam, response }) => {
        const id = requireParam('id');
        const catalog = readModelCatalog(runtime.store);
        const provider = catalog.providers.find((p) => p.id === id);
        if (!provider) throw new NotFoundError('ModelProvider', id);
        try {
          const listed = await listRemoteModels({
            kind: provider.kind,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey
          });
          const models = mergeScannedModels(provider.models, listed.models);
          const updated = patchProvider(runtime.store, id, {
            models,
            scannedAt: new Date().toISOString(),
            scanError: null
          });
          const current = readModelCatalog(runtime.store);
          const firstEnabled = models.find((m) => m.enabled);
          if (!current.defaultRef && firstEnabled) {
            setCatalogDefaultRef(runtime.store, { providerId: id, modelId: firstEnabled.id });
          }
          json(response, 200, {
            ok: true,
            scanned: listed.models.length,
            endpoint: listed.endpoint,
            provider: publicProvider(updated!, 'ui'),
            ...publicCatalogPayload(runtime.store, process.env)
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const updated = patchProvider(runtime.store, id, { scanError: message });
          json(response, 200, {
            ok: false,
            error: message,
            provider: updated ? publicProvider(updated, 'ui') : undefined,
            ...publicCatalogPayload(runtime.store, process.env)
          });
        }
      }
    }
  ];
}
