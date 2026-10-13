import { AuthorizationError, NotFoundError, ValidationError } from '@ppeng/agent-core';
import { AgentMemoryStore } from '@ppeng/agent-core';
import type { MemoryFilter, MemoryScope, MemorySettingsPatch } from '@ppeng/agent-core';
import {
  previewContextPackAsync,
  dreamNowForUser,
  formatCompiledContextPack,
  hasPersistedMemorySettings,
  parseCuratorMode,
  parseMemoryEmbeddingMode,
  parseMinTaskTools,
  readMemorySettings,
  writeMemorySettings
} from '@ppeng/agent-core';
import type { RawAgentRuntime, RequestAuth } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { guardSession } from '../session-guard.js';

function getStore(runtime: RawAgentRuntime): AgentMemoryStore {
  return runtime.store.agentMemory();
}

/**
 * Under auth.isolate a caller only reads its own user's memory: whatever userId the request
 * names is ignored in favour of the logged-in user. Other modes keep the requested value.
 */
function effectiveUserId(auth: RequestAuth, requested: string | undefined): string | undefined {
  return auth.isolate && auth.user ? auth.user.id : requested;
}

function optionalString(value: unknown): string | undefined {
  return value != null ? String(value) : undefined;
}

/**
 * Isolated writes land on the caller's own user/tenant; the router already
 * rejected foreign `userId` / `sessionId` and non-admin shared-scope writes.
 */
function memoryWriteOwner(auth: RequestAuth, body: Record<string, unknown>): { userId?: string; tenantId?: string } {
  if (!auth.isolate || !auth.user) {
    return { userId: optionalString(body.userId), tenantId: optionalString(body.tenantId) };
  }
  const shared = body.scope === 'team.memory' || body.scope === 'project.memory';
  return {
    userId: shared ? optionalString(body.userId) : auth.user.id,
    tenantId: auth.user.tenantId
  };
}

const MEMBER_ROLES = new Set(['owner', 'admin', 'member', 'viewer']);

export function memoryRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/memory/settings',
      handler: ({ response }) => {
        const settings = readMemorySettings(runtime.store);
        json(response, 200, {
          settings,
          source: hasPersistedMemorySettings(runtime.store) ? 'ui' : 'default'
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/memory/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as MemorySettingsPatch & Record<string, unknown>;
        const patch: MemorySettingsPatch = {};
        if (body && 'curatorMode' in body) {
          const parsed = parseCuratorMode(body.curatorMode);
          if (!parsed) throw new ValidationError('curatorMode must be inline, observe_only, or off');
          patch.curatorMode = parsed;
        }
        if (body && 'dialogueExtract' in body) patch.dialogueExtract = Boolean(body.dialogueExtract);
        if (body && 'dreamerEnabled' in body) patch.dreamerEnabled = Boolean(body.dreamerEnabled);
        if (body && 'compilerEnabled' in body) patch.compilerEnabled = Boolean(body.compilerEnabled);
        if (body && 'embeddingRecallMode' in body) {
          const parsed = parseMemoryEmbeddingMode(body.embeddingRecallMode);
          if (!parsed) throw new ValidationError('embeddingRecallMode must be auto, on, or off');
          patch.embeddingRecallMode = parsed;
        } else if (body && 'embeddingRecall' in body) {
          patch.embeddingRecall = Boolean(body.embeddingRecall);
        }
        if (body && 'minTaskTools' in body) {
          const parsed = parseMinTaskTools(body.minTaskTools);
          if (parsed === undefined) throw new ValidationError('minTaskTools must be an integer from 0 to 20');
          patch.minTaskTools = parsed;
        }
        const settings = writeMemorySettings(runtime.store, patch);
        json(response, 200, { settings, source: 'ui' as const });
      }
    },
    {
      method: 'GET',
      pattern: '/api/memory/observations',
      handler: ({ url, response, auth }) => {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        if (sessionId) guardSession(runtime, sessionId, auth, { allowMissing: true });
        const observations = getStore(runtime).listObservations({
          sessionId,
          userId: effectiveUserId(auth, url.searchParams.get('userId') ?? undefined),
          limit: Number(url.searchParams.get('limit') || 30) || 30
        });
        json(response, 200, { observations });
      }
    },
    {
      method: 'POST',
      pattern: '/api/memory/preview',
      handler: async ({ readBody, response, auth }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const query = String(body.query ?? '').trim();
        const sessionId = body.sessionId != null ? String(body.sessionId) : 'preview';
        guardSession(runtime, sessionId, auth, { allowMissing: true });
        const requestedUserId = body.userId != null ? String(body.userId) : undefined;
        const session = runtime.store.getSession(sessionId) ?? {
          id: sessionId,
          title: 'preview',
          agentId: 'general',
          mode: 'chat' as const,
          status: 'idle' as const,
          background: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {
            userId: effectiveUserId(auth, requestedUserId),
            tenantId: body.tenantId != null ? String(body.tenantId) : undefined
          },
          todo: [],
          summary: ''
        };
        // Existing session ownership is authoritative; request fields cannot redirect recall.
        // For a sessionless preview, authenticated identity supplies both user and tenant.
        if (!runtime.store.getSession(sessionId) && auth.isolate && auth.user) {
          session.metadata = { ...session.metadata, userId: auth.user.id, tenantId: auth.user.tenantId };
        }
        const pack = await previewContextPackAsync({
          store: runtime.store,
          session,
          query,
          stateDir: runtime.stateDir
        });
        json(response, 200, {
          pack,
          appendix: formatCompiledContextPack(pack)
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/memory/dream-now',
      handler: async ({ readBody, response, auth }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const userId = effectiveUserId(auth, String(body.userId ?? '').trim());
        if (!userId) throw new ValidationError('Missing required field: userId');
        const result = await dreamNowForUser({
          store: getStore(runtime),
          userId,
          tenantId: body.tenantId != null ? String(body.tenantId) : undefined,
          messagesText: body.messagesText != null ? String(body.messagesText) : undefined,
          settingsStore: runtime.store,
          stateDir: runtime.stateDir,
          force: body.force === true
        });
        json(response, 200, { result, run: getStore(runtime).latestDreamRun(userId) });
      }
    },
    {
      method: 'GET',
      pattern: '/api/users/:id/profile',
      handler: ({ requireParam, response }) => {
        const profile = getStore(runtime).getUserProfile(requireParam('id'));
        json(response, 200, { profile });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/users/:id/profile',
      handler: async ({ requireParam, readBody, response }) => {
        const userId = requireParam('id');
        const body = (await readBody()) as Record<string, unknown>;
        const cur = getStore(runtime).getUserProfile(userId);
        const profile = getStore(runtime).upsertUserProfile({
          userId,
          displayName: body.displayName != null ? String(body.displayName) : cur?.displayName,
          bio: body.bio != null ? String(body.bio) : cur?.bio,
          facts: Array.isArray(body.facts) ? body.facts.map(String) : cur?.facts ?? [],
          preferences: Array.isArray(body.preferences) ? body.preferences.map(String) : cur?.preferences ?? []
        });
        json(response, 200, { profile });
      }
    },

    // ── Agent Memory ──────────────────────────────────────────────────────────

    {
      method: 'GET',
      pattern: '/api/memory',
      handler: ({ url, response, auth }) => {
        const store = getStore(runtime);
        const filter: MemoryFilter = {};

        const scope = url.searchParams.get('scope');
        if (scope) filter.scope = scope as MemoryScope;

        const namespace = url.searchParams.get('namespace');
        if (namespace) filter.namespace = namespace;

        const userId = effectiveUserId(auth, url.searchParams.get('userId') ?? undefined);
        if (userId) filter.userId = userId;

        const tenantId = url.searchParams.get('tenantId');
        if (tenantId) filter.tenantId = tenantId;

        const sessionId = url.searchParams.get('sessionId');
        if (sessionId) {
          guardSession(runtime, sessionId, auth, { allowMissing: true });
          filter.sessionId = sessionId;
        }

        const agentId = url.searchParams.get('agentId');
        if (agentId) filter.agentId = agentId;
        else if (url.searchParams.get('agentUnscoped') === '1') filter.agentUnscoped = true;

        const query = url.searchParams.get('query');
        if (query) filter.query = query;

        const limitParam = url.searchParams.get('limit');
        if (limitParam) {
          const n = Number(limitParam);
          if (Number.isFinite(n) && n > 0) filter.limit = n;
        }

        const orderBy = url.searchParams.get('orderBy') as MemoryFilter['orderBy'] | null;
        if (orderBy) filter.orderBy = orderBy;

        const entries = store.search(filter);
        json(response, 200, { entries });
      }
    },

    {
      method: 'POST',
      pattern: '/api/memory',
      handler: async ({ readBody, response, auth }) => {
        const body = (await readBody()) as Record<string, unknown>;
        if (!body.scope || !body.key || body.value === undefined) {
          throw new ValidationError('Missing required fields: scope, key, value');
        }
        const store = getStore(runtime);
        const entry = store.set({
          scope: String(body.scope) as MemoryScope,
          namespace: String(body.namespace ?? 'default'),
          key: String(body.key),
          value: String(body.value),
          ...memoryWriteOwner(auth, body),
          sessionId: optionalString(body.sessionId),
          agentId: body.agentId != null && String(body.agentId).trim() ? String(body.agentId).trim() : undefined,
          importance: body.importance != null ? Number(body.importance) : 0.5,
          source: body.source != null ? String(body.source) : undefined,
          confidence: (body.confidence as 'low' | 'medium' | 'high' | undefined) ?? 'medium',
          expiresAt: body.expiresAt != null ? String(body.expiresAt) : undefined
        });
        json(response, 201, { entry });
      }
    },

    {
      method: 'DELETE',
      pattern: '/api/memory/:id',
      handler: ({ requireParam, response }) => {
        const id = requireParam('id');
        getStore(runtime).delete(id);
        json(response, 200, { ok: true });
      }
    },

    {
      method: 'POST',
      pattern: '/api/memory/expire',
      handler: ({ response }) => {
        const count = getStore(runtime).expire();
        json(response, 200, { deleted: count });
      }
    },

    // ── Users ─────────────────────────────────────────────────────────────────

    {
      method: 'GET',
      pattern: '/api/users',
      handler: ({ response, auth }) => {
        const store = getStore(runtime);
        if (auth.isolate && auth.user) {
          const user = store.getUser(auth.user.id);
          json(response, 200, { users: user ? [user] : [] });
          return;
        }
        json(response, 200, { users: store.listUsers() });
      }
    },

    {
      method: 'POST',
      pattern: '/api/users',
      handler: async ({ readBody, response, auth }) => {
        if (auth.isolate) throw new AuthorizationError();
        const body = (await readBody()) as Record<string, unknown>;
        if (!body.id) throw new ValidationError('Missing required field: id');
        const store = getStore(runtime);
        const now = new Date().toISOString();
        store.upsertUser({
          id: String(body.id),
          email: body.email != null ? String(body.email) : undefined,
          displayName: body.displayName != null ? String(body.displayName) : undefined,
          status: body.status != null ? String(body.status) : 'active',
          createdAt: body.createdAt != null ? String(body.createdAt) : now
        });
        const user = store.getUser(String(body.id));
        json(response, 201, { user });
      }
    },

    {
      method: 'GET',
      pattern: '/api/users/:id',
      handler: ({ requireParam, response, auth }) => {
        const id = requireParam('id');
        if (auth.isolate && auth.user && auth.user.id !== id) {
          json(response, 404, { error: 'User not found' });
          return;
        }
        const user = getStore(runtime).getUser(id);
        if (!user) {
          json(response, 404, { error: 'User not found' });
          return;
        }
        json(response, 200, { user });
      }
    },

    // ── Tenants ───────────────────────────────────────────────────────────────

    {
      method: 'GET',
      pattern: '/api/tenants',
      handler: ({ response }) => {
        const tenants = getStore(runtime).listTenants();
        json(response, 200, { tenants });
      }
    },

    {
      method: 'POST',
      pattern: '/api/tenants',
      handler: async ({ readBody, response, auth }) => {
        if (auth.isolate) throw new AuthorizationError();
        const body = (await readBody()) as Record<string, unknown>;
        if (!body.id || !body.name) throw new ValidationError('Missing required fields: id, name');
        const store = getStore(runtime);
        const now = new Date().toISOString();
        store.upsertTenant({
          id: String(body.id),
          name: String(body.name),
          createdAt: body.createdAt != null ? String(body.createdAt) : now
        });
        const tenant = store.getTenant(String(body.id));
        json(response, 201, { tenant });
      }
    },

    {
      method: 'PUT',
      pattern: '/api/tenants/:id/members/:userId',
      handler: async ({ requireParam, readBody, response, auth }) => {
        if (auth.isolate && auth.user?.tenantId !== requireParam('id')) throw new AuthorizationError();
        const body = (await readBody()) as Record<string, unknown>;
        const role = String(body.role ?? '');
        if (!MEMBER_ROLES.has(role)) throw new ValidationError('role must be owner, admin, member, or viewer');
        const store = getStore(runtime);
        const userId = requireParam('userId');
        if (!store.getUser(userId)) throw new NotFoundError('User', userId);
        store.addMembership({ userId, tenantId: requireParam('id'), role });
        json(response, 200, { memberships: store.getMemberships(userId) });
      }
    }
  ];
}
