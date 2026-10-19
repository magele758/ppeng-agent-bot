/**
 * Chat-bot control of product features the Lab already exposes:
 * bots, group chats, groups, sessions, settings, and related records.
 * Reuses the same stores and services as the daemon routes.
 */

import { withProductAccess } from './product-admin-access.js';
import { createId, nowIso } from '../id.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import type { RunContext, SessionRecord, ToolContract } from '../types.js';
import type { SessionFacadeHost } from '../runtime/session-facade.js';
import { createChatSession } from '../runtime/session-facade.js';
import { parsePermissionMode } from '../approval/permission-mode.js';
import { parseSessionMaxTurns } from '../runtime/session-max-turns.js';
import {
  botDefinitionOwner,
  principalFromSession,
  resolveBotPrincipal,
  sameBotPrincipal,
  setBotDefinitionOwner,
  type BotPrincipal
} from '../bots/bot-identity.js';
import { createBot, getBot, openBot, updateBot } from '../bots/bot-facade.js';
import { normalizeBotModelOverride, readBotModelOverride } from '../bots/bot-model.js';
import { BotFunctionalGroupService } from '../bots/functional-groups.js';
import { setBotWorkControl, type BotWorkHost } from '../bots/bot-work.js';
import type { BotRecord, UpdateBotInput } from '../bots/types.js';
import type { BotRoomService } from '../rooms/index.js';
import { tryCreateDynToolStore } from '../dyn-tools/store.js';
import { createLogger } from '../logger.js';
import {
  deleteProvider,
  findProvider,
  patchProvider,
  pickerOptions,
  publicCatalogPayload,
  publicProvider,
  readModelCatalog,
  setCatalogDefaultRef,
  upsertProvider,
  type ModelProvider
} from '../model/provider-catalog.js';
import { GOAL_CONDITION_META, GOAL_ENABLED_META, GOAL_MAX_TURNS_META } from '../goal/types.js';
import { goalWirePayload, upsertGoalFromApi } from '../goal/entity.js';
import { createSwarmId } from '../swarm/store.js';
import type { SwarmRole, SwarmStrategy } from '../swarm/types.js';
import type { ResearchStatus } from '../deepresearch/types.js';
import type { OrchestrationStatus, RiskLevel } from '../orchestrator/types.js';
import { validateWorkspaceRootPath } from '../workspace/validate.js';
import { listSettingsAreas, readSettingsArea, writeSettingsArea } from './product-admin-settings.js';

const log = createLogger('product-admin');

export interface ProductAdminHost {
  store: SqliteStateStore;
  facade: SessionFacadeHost;
  rooms: BotRoomService;
  toolNames: () => readonly string[];
  skillNames?: () => Promise<readonly string[]>;
  createTeamPlan?: (input: {
    objective: string;
    sessionId?: string;
    tasks?: unknown;
  }) => Promise<{ plan?: unknown; error?: string }>;
  startTeamPlan?: (planId: string) => unknown;
  resumeTeamPlan?: (planId: string) => unknown;
  startSwarmRun?: (
    runId: string,
    seedTasks?: Array<{ title: string; description?: string; requiredRole?: string; blockedBy?: string[] }>
  ) => unknown;
  cancelSession?: (sessionId: string) => void;
}

const SECRET_FIELD = /^(apiKey|api_key|apiKeyMasked|secretKey|secret|token|password|accessToken|refreshToken|authorization|privateKey|publicKey)$/i;
const LAB_MODEL_NOTICE = '用实验室里已配置的模型。不要读取 API key、token 或 secret。';
const SWARM_STRATEGIES = new Set<SwarmStrategy>(['pipeline', 'parallel-review', 'best-of-n', 'debate', 'research-implement-review']);
const RESEARCH_STATUSES = new Set<ResearchStatus>(['pending', 'searching', 'extracting', 'synthesizing', 'critiquing', 'completed', 'failed']);
const ORCH_STATUSES = new Set<OrchestrationStatus>(['pending', 'running', 'waiting_approval', 'completed', 'failed', 'blocked']);
const RISK = new Set<RiskLevel>(['low', 'medium', 'high']);

function assertNoSecretFields(value: unknown, depth = 0): void {
  if (depth > 8 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new ValidationError(LAB_MODEL_NOTICE);
    assertNoSecretFields(item, depth + 1);
  }
}

function pinLabModel(
  store: SqliteStateStore,
  raw: unknown
): { pin: { providerId: string; modelId: string } | null; notice?: string } {
  const catalog = readModelCatalog(store);
  const options = pickerOptions(catalog, process.env).map((option) => ({
    providerId: option.providerId,
    modelId: option.modelId
  }));
  const pin = normalizeBotModelOverride(raw, options);
  if (!pin) return { pin: null };
  const provider = findProvider(catalog, pin.providerId, process.env);
  const usable = !!provider && (provider.kind === 'heuristic' || Boolean(provider.apiKey.trim() && provider.baseUrl.trim()));
  if (!usable) return { pin: null, notice: LAB_MODEL_NOTICE };
  return { pin: { providerId: pin.providerId, modelId: pin.modelId } };
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key) && typeof item === 'string') {
      out[`${key}Present`] = item.trim().length > 0;
      continue;
    }
    out[key] = redactSecrets(item);
  }
  return out;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[redacted]');
}

function assertWritable(session: SessionRecord): void {
  if (session.mode === 'subagent') {
    throw new ValidationError('Subagents cannot change product configuration');
  }
  if (typeof session.metadata?.roomId === 'string' && session.metadata.roomId.trim()) {
    throw new ValidationError('Group-chat turns cannot change product configuration');
  }
  if (session.metadata?.permissionMode === 'plan') {
    throw new ValidationError('Plan mode is read-only. Switch permission mode before changing product configuration');
  }
}

function principalOf(store: SqliteStateStore, session: SessionRecord): BotPrincipal {
  return principalFromSession(store, session);
}

function assertCanManageBot(store: SqliteStateStore, principal: BotPrincipal, bot: BotRecord): void {
  const owner = botDefinitionOwner(store, bot.id);
  const installation = resolveBotPrincipal(store);
  if (!owner) {
    const session = store.getSession(bot.canonicalSessionId);
    if (!session || !sameBotPrincipal(principalFromSession(store, session), principal)) {
      throw new AuthorizationError('Bot belongs to another principal');
    }
  }
  if (owner && !sameBotPrincipal(owner, principal) && !sameBotPrincipal(owner, installation)) {
    throw new AuthorizationError('Bot belongs to another principal');
  }
}

function resolveBot(store: SqliteStateStore, ref: string): BotRecord {
  const name = ref.trim();
  if (!name) throw new ValidationError('Bot id or name is required');
  const hit = store.listBots({ includeHidden: true }).find((bot) => bot.id === name || bot.name === name);
  if (!hit) throw new NotFoundError('Bot', name);
  return hit;
}

function managedBot(store: SqliteStateStore, principal: BotPrincipal, ref: string): BotRecord {
  const bot = resolveBot(store, ref);
  assertCanManageBot(store, principal, bot);
  return bot;
}

function botView(store: SqliteStateStore, bot: BotRecord) {
  const session = store.getSession(bot.canonicalSessionId);
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    hidden: bot.hidden,
    faceShape: bot.faceShape,
    faceColor: bot.faceColor,
    avatar: bot.avatar,
    canonicalSessionId: bot.canonicalSessionId,
    maxTurns: session?.metadata?.maxTurns ?? null,
    allowedTools: session?.metadata?.allowedTools ?? null,
    allowedSkills: session?.metadata?.allowedSkills ?? null,
    modelOverride: readBotModelOverride(session?.metadata) ?? null,
    persona: typeof session?.metadata?.persona === 'string' && session.metadata.persona.trim()
      ? session.metadata.persona
      : null
  };
}

function sessionVisible(store: SqliteStateStore, session: SessionRecord, principal: BotPrincipal): boolean {
  const owner = principalFromSession(store, session);
  const installation = resolveBotPrincipal(store);
  if (sameBotPrincipal(principal, installation)) return sameBotPrincipal(owner, installation);
  return sameBotPrincipal(owner, principal);
}

function ownSession(store: SqliteStateStore, principal: BotPrincipal, id: string): SessionRecord {
  const session = store.getSession(id);
  if (!session || !sessionVisible(store, session, principal)) throw new NotFoundError('Session', id);
  return session;
}

function sessionView(session: SessionRecord) {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    mode: session.mode,
    agentId: session.agentId,
    botId: typeof session.metadata?.botId === 'string' ? session.metadata.botId : null,
    roomId: typeof session.metadata?.roomId === 'string' ? session.metadata.roomId : null,
    canonicalBotChat: session.metadata?.canonicalBotChat === true,
    permissionMode: session.metadata?.permissionMode ?? null,
    maxTurns: session.metadata?.maxTurns ?? null
  };
}

function sharedScope(raw: string): 'global' | 'group' | 'room' {
  if (raw === 'global' || raw === 'group' || raw === 'room') return raw;
  throw new ValidationError('scope must be global, group, or room');
}

function stringList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ValidationError(`${label} must be a non-empty list of strings`);
  }
  return raw.map((item) => String(item).trim());
}

function providerView(provider: ModelProvider) {
  const view = publicProvider(provider, 'ui');
  const { apiKeyMasked: _masked, ...rest } = view;
  return rest;
}

function catalogView(store: SqliteStateStore) {
  const payload = publicCatalogPayload(store, process.env);
  return {
    ...payload,
    catalog: {
      ...payload.catalog,
      providers: payload.catalog.providers.map((provider) => {
        const { apiKeyMasked: _masked, ...rest } = provider;
        return rest;
      })
    }
  };
}

function workHost(store: SqliteStateStore): BotWorkHost {
  return { store, async runSession() {}, log };
}

interface Spec {
  name: string;
  description: string;
  properties?: Record<string, unknown>;
  required?: string[];
  approval: 'never' | 'auto' | 'always';
  write?: boolean;
  confirm?: string;
  run: (ctx: RunContext, args: Record<string, unknown>) => Promise<unknown>;
}

function define(spec: Spec, store: SqliteStateStore): ToolContract<Record<string, unknown>> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: 'object',
      properties: spec.properties ?? {},
      ...(spec.required ? { required: spec.required } : {})
    },
    approvalMode: spec.approval,
    sideEffectLevel: spec.approval === 'never' ? 'none' : 'system',
    async execute(ctx, args) {
      try {
        const input = args ?? {};
        if (spec.write) assertWritable(ctx.session);
        if (spec.confirm && input.confirm !== true) {
          throw new ValidationError(`${spec.confirm} requires confirm: true`);
        }
        return { ok: true, content: JSON.stringify(redactSecrets(await withProductAccess(store, ctx.session, spec.name, spec.write === true, input, () => spec.run(ctx, input)))) };
      } catch (error) {
        return { ok: false, content: JSON.stringify({ error: safeError(error) }) };
      }
    }
  };
}

export function createProductAdminTools(host: ProductAdminHost): ToolContract<Record<string, unknown>>[] {
  const store = host.store;
  const groups = () => new BotFunctionalGroupService(store, host.cancelSession);
  const str = (args: Record<string, unknown>, key: string) => (typeof args[key] === 'string' ? args[key].trim() : '');

  const tools: Spec[] = [
    {
      name: 'bot_list',
      description: 'List bots you can manage, including hidden ones. You can create more with bot_create.',
      approval: 'never',
      async run(ctx) {
        const principal = principalOf(store, ctx.session);
        const bots = store.listBots({ includeHidden: true }).filter((bot) => {
          try {
            assertCanManageBot(store, principal, bot);
            return true;
          } catch {
            return false;
          }
        });
        return { bots: bots.map((bot) => botView(store, bot)) };
      }
    },
    {
      name: 'bot_get',
      description: 'Read one bot configuration by id or name. You can change it with bot_update.',
      properties: { bot: { type: 'string' } },
      required: ['bot'],
      approval: 'never',
      async run(ctx, args) {
        const bot = managedBot(store, principalOf(store, ctx.session), str(args, 'bot'));
        return { bot: botView(store, bot) };
      }
    },
    {
      name: 'bot_create',
      description: 'Create a bot in this product. You can do this. Same capability as create_bot. Required: name. Optional: title, description, persona, allowedTools, allowedSkills, modelOverride {providerId, modelId} for a model already configured in the lab, faceShape, faceColor, avatar, maxTurns (24|48|96). Do not send API keys, tokens, secrets, or passwords.',
      properties: {
        name: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        persona: { type: 'string' },
        allowedTools: { type: 'array', items: { type: 'string' } },
        allowedSkills: { type: 'array', items: { type: 'string' } },
        modelOverride: {
          type: 'object',
          additionalProperties: false,
          properties: {
            providerId: { type: 'string' },
            modelId: { type: 'string' }
          },
          required: ['providerId', 'modelId']
        },
        faceShape: { type: 'string' },
        faceColor: { type: 'string' },
        avatar: { type: 'string' },
        maxTurns: { type: 'number' }
      },
      required: ['name'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        assertNoSecretFields(args);
        let modelNotice: string | undefined;
        let modelPin: { providerId: string; modelId: string } | undefined;
        if ('modelOverride' in args) {
          const decision = pinLabModel(store, args.modelOverride);
          if (decision.notice) modelNotice = decision.notice;
          else if (decision.pin) modelPin = decision.pin;
        }
        const skillCatalog = 'allowedSkills' in args && host.skillNames
          ? (await host.skillNames()).map((name) => ({ name })) : undefined;
        if ('allowedSkills' in args && !skillCatalog) throw new ValidationError('allowedSkills requires a skill catalog');
        return store.transaction(() => {
        const principal = principalOf(store, ctx.session);
        const persona = typeof args.persona === 'string' ? args.persona.trim() : '';
        const bot = createBot(host.facade, {
          name: str(args, 'name'),
          title: typeof args.title === 'string' ? args.title : undefined,
          description: typeof args.description === 'string' ? args.description : undefined,
          faceShape: args.faceShape,
          faceColor: args.faceColor,
          avatar: args.avatar
        });
        setBotDefinitionOwner(store, bot.id, principal);
        const session = store.getSession(bot.canonicalSessionId);
        if (session) {
          store.updateSession(session.id, {
            metadata: {
              ...session.metadata,
              userId: principal.userId,
              ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
              ...(persona ? { persona } : {})
            }
          });
        }
        const patch: UpdateBotInput = {};
        if ('maxTurns' in args) patch.maxTurns = args.maxTurns;
        if ('allowedTools' in args) patch.allowedTools = args.allowedTools;
        if ('allowedSkills' in args) patch.allowedSkills = args.allowedSkills;
        if (modelPin) patch.modelOverride = modelPin;
        let next = getBot(store, bot.id);
        if (persona || Object.keys(patch).length > 0) {
          const dyn = tryCreateDynToolStore(store);
          next = updateBot(host.facade, bot.id, patch, {
            toolCatalog: host.toolNames().map((name) => ({ name })),
            dynToolNames: dyn ? dyn.list({ sessionId: bot.canonicalSessionId }).map((record) => record.name) : undefined,
            skillCatalog,
            modelOptions: pickerOptions(readModelCatalog(store), process.env).map((option) => ({
              providerId: option.providerId,
              modelId: option.modelId
            }))
          });
        }
        const view = { bot: botView(store, next) };
        return modelNotice ? { ...view, modelNotice } : view;
        });
      }
    },
    {
      name: 'bot_update',
      description: 'Update a bot: name, title, description, hidden, maxTurns (24|48|96), allowedTools, allowedSkills, modelOverride, face, or avatar. You can do this. Empty allowedTools or allowedSkills clears the allowlist.',
      properties: {
        bot: { type: 'string' },
        name: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        hidden: { type: 'boolean' },
        maxTurns: { type: 'number' },
        allowedTools: { type: 'array', items: { type: 'string' } },
        allowedSkills: { type: 'array', items: { type: 'string' } },
        modelOverride: {},
        faceShape: {},
        faceColor: {},
        avatar: {}
      },
      required: ['bot'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const bot = managedBot(store, principalOf(store, ctx.session), str(args, 'bot'));
        const patch: UpdateBotInput = {};
        if (typeof args.name === 'string') patch.name = args.name;
        if (typeof args.title === 'string') patch.title = args.title;
        if (typeof args.description === 'string') patch.description = args.description;
        if (typeof args.hidden === 'boolean') patch.hidden = args.hidden;
        if ('maxTurns' in args) patch.maxTurns = args.maxTurns;
        if ('allowedTools' in args) patch.allowedTools = args.allowedTools;
        if ('allowedSkills' in args) patch.allowedSkills = args.allowedSkills;
        if ('modelOverride' in args) patch.modelOverride = args.modelOverride;
        if ('faceShape' in args) patch.faceShape = args.faceShape;
        if ('faceColor' in args) patch.faceColor = args.faceColor;
        if ('avatar' in args) patch.avatar = args.avatar;
        const dyn = tryCreateDynToolStore(store);
        const skillCatalog = patch.allowedSkills !== undefined && host.skillNames
          ? (await host.skillNames()).map((name) => ({ name }))
          : undefined;
        if (patch.allowedSkills !== undefined && !skillCatalog) {
          throw new ValidationError('allowedSkills requires a skill catalog');
        }
        const next = updateBot(host.facade, bot.id, patch, {
          toolCatalog: host.toolNames().map((name) => ({ name })),
          dynToolNames: dyn ? dyn.list({ sessionId: bot.canonicalSessionId }).map((record) => record.name) : undefined,
          skillCatalog,
          modelOptions: pickerOptions(readModelCatalog(store), process.env).map((option) => ({
            providerId: option.providerId,
            modelId: option.modelId
          }))
        });
        return { bot: botView(store, next) };
      }
    },
    {
      name: 'bot_open',
      description: 'Open a bot private chat and return its session id. You can do this.',
      properties: { bot: { type: 'string' } },
      required: ['bot'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const bot = managedBot(store, principal, str(args, 'bot'));
        const opened = openBot(host.facade, bot.id, principal);
        return { bot: botView(store, opened.bot), sessionId: opened.sessionId, createdSession: opened.createdSession };
      }
    },
    {
      name: 'bot_work_control_set',
      description: 'Pause or disable delegated work for a bot. You can do this. Both paused and disabled are required booleans.',
      properties: { bot: { type: 'string' }, paused: { type: 'boolean' }, disabled: { type: 'boolean' } },
      required: ['bot', 'paused', 'disabled'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const bot = managedBot(store, principal, str(args, 'bot'));
        const control = setBotWorkControl(workHost(store), principal, bot.id, {
          paused: args.paused === true,
          disabled: args.disabled === true
        });
        return { botId: bot.id, control };
      }
    },
    {
      name: 'bot_room_list',
      description: 'List your group chats. You can create one with bot_room_create.',
      approval: 'never',
      async run(ctx) {
        return { rooms: host.rooms.list(principalOf(store, ctx.session)) };
      }
    },
    {
      name: 'bot_room_get',
      description: 'Read one group chat: title, members, host, and budgets.',
      properties: { roomId: { type: 'string' } },
      required: ['roomId'],
      approval: 'never',
      async run(ctx, args) {
        return { room: host.rooms.get(principalOf(store, ctx.session), str(args, 'roomId')) };
      }
    },
    {
      name: 'bot_room_create',
      description: 'Create a group chat. You can do this. Same capability as create_room. Required: title and botIds (ids or names). Optional: hostBotId, maxBotTurns (1-20), maxToolCalls, maxCostUsd.',
      properties: {
        title: { type: 'string' },
        botIds: { type: 'array', items: { type: 'string' } },
        hostBotId: { type: 'string' },
        maxBotTurns: { type: 'number' },
        maxToolCalls: { type: 'number' },
        maxCostUsd: { type: 'number' }
      },
      required: ['title', 'botIds'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const botIds = stringList(args.botIds, 'botIds').map((ref) => managedBot(store, principal, ref).id);
        const hostBotId = typeof args.hostBotId === 'string' && args.hostBotId.trim()
          ? managedBot(store, principal, args.hostBotId).id
          : undefined;
        const room = host.rooms.create(principal, {
          title: str(args, 'title'),
          botIds,
          hostBotId,
          maxBotTurns: typeof args.maxBotTurns === 'number' ? args.maxBotTurns : undefined,
          maxToolCalls: typeof args.maxToolCalls === 'number' ? args.maxToolCalls : undefined,
          maxCostUsd: typeof args.maxCostUsd === 'number' ? args.maxCostUsd : undefined
        });
        return { room };
      }
    },
    {
      name: 'bot_room_update',
      description: 'Update a group chat title, host, maxBotTurns, maxToolCalls, maxCostUsd, or status (active|paused). You can do this.',
      properties: {
        roomId: { type: 'string' },
        title: { type: 'string' },
        hostBotId: { type: 'string' },
        maxBotTurns: { type: 'number' },
        maxToolCalls: { type: 'number' },
        maxCostUsd: { type: 'number' },
        status: { type: 'string', enum: ['active', 'paused'] }
      },
      required: ['roomId'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const patch: { title?: string; hostBotId?: string; maxBotTurns?: number; maxToolCalls?: number; maxCostUsd?: number; status?: 'active' | 'paused' } = {};
        if (typeof args.title === 'string') patch.title = args.title;
        if (typeof args.hostBotId === 'string') patch.hostBotId = managedBot(store, principal, args.hostBotId).id;
        if (typeof args.maxBotTurns === 'number') patch.maxBotTurns = args.maxBotTurns;
        if (typeof args.maxToolCalls === 'number') patch.maxToolCalls = args.maxToolCalls;
        if (typeof args.maxCostUsd === 'number') patch.maxCostUsd = args.maxCostUsd;
        if (args.status === 'active' || args.status === 'paused') patch.status = args.status;
        const room = host.rooms.patch(principal, str(args, 'roomId'), patch);
        void host.rooms.tick().catch((error) => log.warn('room tick failed', { error: String(error) }));
        return { room };
      }
    },
    {
      name: 'bot_room_add_member',
      description: 'Add a bot to a group chat. You can do this.',
      properties: { roomId: { type: 'string' }, bot: { type: 'string' } },
      required: ['roomId', 'bot'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const bot = managedBot(store, principal, str(args, 'bot'));
        return { room: host.rooms.addMember(principal, str(args, 'roomId'), bot.id) };
      }
    },
    {
      name: 'bot_room_remove_member',
      description: 'Remove a bot from a group chat. Destructive: pass confirm true.',
      properties: { roomId: { type: 'string' }, bot: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['roomId', 'bot', 'confirm'],
      approval: 'always',
      write: true,
      confirm: 'Removing a group-chat member',
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const bot = managedBot(store, principal, str(args, 'bot'));
        return { room: host.rooms.removeMember(principal, str(args, 'roomId'), bot.id) };
      }
    },
    {
      name: 'bot_room_delete',
      description: 'Delete a group chat. Bots and their private chats stay. Destructive: pass confirm true.',
      properties: { roomId: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['roomId', 'confirm'],
      approval: 'always',
      write: true,
      confirm: 'Deleting a group chat',
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const roomId = str(args, 'roomId');
        host.rooms.delete(principal, roomId);
        return { deleted: true, roomId };
      }
    },
    {
      name: 'bot_room_messages',
      description: 'Read group-chat messages. Optional limit and beforeSeq.',
      properties: { roomId: { type: 'string' }, limit: { type: 'number' }, beforeSeq: { type: 'number' } },
      required: ['roomId'],
      approval: 'never',
      async run(ctx, args) {
        return host.rooms.messages(principalOf(store, ctx.session), str(args, 'roomId'), {
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          beforeSeq: typeof args.beforeSeq === 'number' ? args.beforeSeq : undefined
        });
      }
    },
    {
      name: 'bot_room_post',
      description: 'Post a user message into a group chat and queue member turns. You can do this.',
      properties: { roomId: { type: 'string' }, text: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } } },
      required: ['roomId', 'text'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const result = host.rooms.send(principalOf(store, ctx.session), str(args, 'roomId'), {
          text: str(args, 'text'),
          mentions: Array.isArray(args.mentions) ? args.mentions.map(String) : undefined,
          idempotencyKey: createId('room_post')
        });
        void host.rooms.tick().catch((error) => log.warn('room tick failed', { error: String(error) }));
        return result;
      }
    },
    {
      name: 'bot_room_stop',
      description: 'Pause a group chat and cancel its active turns. You can do this.',
      properties: { roomId: { type: 'string' } },
      required: ['roomId'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        return { room: host.rooms.stop(principalOf(store, ctx.session), str(args, 'roomId')) };
      }
    },
    {
      name: 'bot_room_resume',
      description: 'Resume a paused group chat. You can do this.',
      properties: { roomId: { type: 'string' } },
      required: ['roomId'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const room = host.rooms.resume(principalOf(store, ctx.session), str(args, 'roomId'));
        void host.rooms.tick().catch((error) => log.warn('room tick failed', { error: String(error) }));
        return { room };
      }
    },
    {
      name: 'bot_group_list',
      description: 'List functional groups. You can create one with bot_group_create.',
      approval: 'never',
      async run(ctx) {
        return { groups: groups().list(principalOf(store, ctx.session)) };
      }
    },
    {
      name: 'bot_group_create',
      description: 'Create a functional group. You can do this. Required: name.',
      properties: { name: { type: 'string' } },
      required: ['name'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        return { group: groups().create(principalOf(store, ctx.session), str(args, 'name')) };
      }
    },
    {
      name: 'bot_group_rename',
      description: 'Rename a functional group. You can do this.',
      properties: { groupId: { type: 'string' }, name: { type: 'string' } },
      required: ['groupId', 'name'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        return { group: groups().rename(principalOf(store, ctx.session), str(args, 'groupId'), str(args, 'name')) };
      }
    },
    {
      name: 'bot_group_delete',
      description: 'Delete a functional group. Bots stay. Destructive: pass confirm true.',
      properties: { groupId: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['groupId', 'confirm'],
      approval: 'always',
      write: true,
      confirm: 'Deleting a functional group',
      async run(ctx, args) {
        const groupId = str(args, 'groupId');
        groups().delete(principalOf(store, ctx.session), groupId);
        return { deleted: true, groupId };
      }
    },
    {
      name: 'bot_group_assign',
      description: 'Move a bot into a functional group. Pass groupId null to remove it from every group. You can do this.',
      properties: { bot: { type: 'string' }, groupId: {} },
      required: ['bot'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const bot = managedBot(store, principal, str(args, 'bot'));
        const groupId = args.groupId === null || args.groupId === '' ? null : str(args, 'groupId');
        if (groupId === '' ) throw new ValidationError('groupId must be an id or null');
        groups().move(principal, bot.id, groupId || null);
        return { botId: bot.id, groupId: groups().groupIdForBot(principal, bot.id) };
      }
    },
    {
      name: 'bot_shared_context_get',
      description: 'Read shared facts for scope global, group, or room.',
      properties: { scope: { type: 'string', enum: ['global', 'group', 'room'] }, id: { type: 'string' } },
      required: ['scope'],
      approval: 'never',
      async run(ctx, args) {
        const scope = sharedScope(str(args, 'scope'));
        const target = scope === 'global' ? { scope } : { scope, id: str(args, 'id') };
        return { entries: groups().getShared(principalOf(store, ctx.session), target) };
      }
    },
    {
      name: 'bot_shared_context_set',
      description: 'Replace shared facts for scope global, group, or room. entries is an object of short text values. You can do this.',
      properties: { scope: { type: 'string', enum: ['global', 'group', 'room'] }, id: { type: 'string' }, entries: { type: 'object' } },
      required: ['scope', 'entries'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const scope = sharedScope(str(args, 'scope'));
        const target = scope === 'global' ? { scope } : { scope, id: str(args, 'id') };
        return { entries: groups().setShared(principalOf(store, ctx.session), target, args.entries) };
      }
    },
    {
      name: 'lab_session_list',
      description: 'List chat sessions you own. You can create one with lab_session_create.',
      approval: 'never',
      async run(ctx) {
        const principal = principalOf(store, ctx.session);
        const sessions = store.listSessions().filter((session) => sessionVisible(store, session, principal)).slice(0, 80);
        return { sessions: sessions.map(sessionView) };
      }
    },
    {
      name: 'lab_session_create',
      description: 'Create a chat session. You can do this. Optional title, agentId, and first message. Cannot set permissionMode to bypass.',
      properties: { title: { type: 'string' }, agentId: { type: 'string' }, message: { type: 'string' } },
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const principal = principalOf(store, ctx.session);
        const session = createChatSession(host.facade, {
          title: str(args, 'title') || 'Chat Session',
          agentId: str(args, 'agentId') || 'general',
          message: typeof args.message === 'string' ? args.message : undefined,
          metadata: { userId: principal.userId, ...(principal.tenantId ? { tenantId: principal.tenantId } : {}) }
        });
        return { session: sessionView(session) };
      }
    },
    {
      name: 'lab_session_update',
      description: 'Rename a session or set maxTurns (24|48|96) or permissionMode (plan|ask|acceptEdits|auto). bypass stays a human-only switch. You can do this.',
      properties: {
        sessionId: { type: 'string' },
        title: { type: 'string' },
        maxTurns: { type: 'number' },
        permissionMode: { type: 'string' }
      },
      required: ['sessionId'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const session = ownSession(store, principalOf(store, ctx.session), str(args, 'sessionId'));
        const metadata = { ...session.metadata };
        if ('maxTurns' in args) metadata.maxTurns = parseSessionMaxTurns(args.maxTurns);
        if ('permissionMode' in args) {
          const mode = parsePermissionMode(args.permissionMode);
          if (mode === 'bypass') throw new ValidationError('bypass can only be set by a person');
          if (!mode) throw new ValidationError('permissionMode must be plan, ask, acceptEdits, or auto');
          metadata.permissionMode = mode;
        }
        const next = store.updateSession(session.id, {
          ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title.trim() } : {}),
          metadata
        });
        return { session: sessionView(next) };
      }
    },
    {
      name: 'lab_session_delete',
      description: 'Delete a non-canonical chat session. Refuses a bot private canonical chat. Destructive: pass confirm true.',
      properties: { sessionId: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['sessionId', 'confirm'],
      approval: 'always',
      write: true,
      confirm: 'Deleting a session',
      async run(ctx, args) {
        const session = ownSession(store, principalOf(store, ctx.session), str(args, 'sessionId'));
        if (session.metadata?.canonicalBotChat === true) {
          throw new ValidationError('A bot canonical chat cannot be deleted. Hide the bot instead');
        }
        host.cancelSession?.(session.id);
        const deleted = store.deleteSession(session.id);
        return { deleted, sessionId: session.id };
      }
    },
    {
      name: 'lab_settings_list',
      description: 'List Lab settings areas you can read and update. Secret fields are write-only and are never returned.',
      approval: 'never',
      async run() {
        return { areas: listSettingsAreas() };
      }
    },
    {
      name: 'lab_settings_get',
      description: 'Read one Lab settings area from lab_settings_list. Secrets are omitted.',
      properties: { area: { type: 'string' } },
      required: ['area'],
      approval: 'never',
      async run(_ctx, args) {
        return readSettingsArea(store, str(args, 'area'));
      }
    },
    {
      name: 'lab_settings_update',
      description: 'Update one Lab settings area. You can do this. patch uses the fields from lab_settings_list. API keys may be saved but are never echoed back.',
      properties: { area: { type: 'string' }, patch: { type: 'object' } },
      required: ['area', 'patch'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        return writeSettingsArea(store, str(args, 'area'), args.patch);
      }
    },
    {
      name: 'lab_model_providers_list',
      description: 'List model providers and the default model. API keys are not included.',
      approval: 'never',
      async run() {
        return catalogView(store);
      }
    },
    {
      name: 'lab_model_provider_upsert',
      description: 'Create or update a model provider. You can do this. apiKey is write-only and is not returned. Required on create: name and modelId. Optional: id, kind, baseUrl, useJsonMode.',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['openai-compatible', 'anthropic-compatible', 'heuristic'] },
        baseUrl: { type: 'string' },
        apiKey: { type: 'string' },
        modelId: { type: 'string' },
        useJsonMode: { type: 'boolean' }
      },
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const id = str(args, 'id');
        const existing = id ? readModelCatalog(store).providers.find((provider) => provider.id === id) : undefined;
        if (existing) {
          const next = patchProvider(store, existing.id, {
            name: typeof args.name === 'string' ? args.name : undefined,
            kind: args.kind === 'openai-compatible' || args.kind === 'anthropic-compatible' || args.kind === 'heuristic' ? args.kind : undefined,
            baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
            apiKey: typeof args.apiKey === 'string' ? args.apiKey : undefined,
            useJsonMode: typeof args.useJsonMode === 'boolean' ? args.useJsonMode : undefined,
            models: typeof args.modelId === 'string' && args.modelId.trim()
              ? [{ id: args.modelId.trim(), enabled: true }]
              : undefined
          });
          if (!next) throw new NotFoundError('Model provider', existing.id);
          return { provider: providerView(next) };
        }
        const modelId = str(args, 'modelId');
        if (!str(args, 'name') || !modelId) throw new ValidationError('name and modelId are required to create a provider');
        const created = upsertProvider(store, {
          name: str(args, 'name'),
          kind: args.kind === 'anthropic-compatible' || args.kind === 'heuristic' ? args.kind : 'openai-compatible',
          baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : '',
          apiKey: typeof args.apiKey === 'string' ? args.apiKey : '',
          useJsonMode: args.useJsonMode !== false,
          models: [{ id: modelId, enabled: true }]
        });
        return { provider: providerView(created) };
      }
    },
    {
      name: 'lab_model_provider_delete',
      description: 'Delete a model provider. Destructive: pass confirm true. The key is not returned.',
      properties: { id: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['id', 'confirm'],
      approval: 'always',
      write: true,
      confirm: 'Deleting a model provider',
      async run(_ctx, args) {
        const id = str(args, 'id');
        if (id === 'heuristic') throw new ValidationError('The built-in heuristic provider cannot be deleted');
        const deleted = deleteProvider(store, id);
        if (!deleted) throw new NotFoundError('Model provider', id);
        return { deleted: true, id };
      }
    },
    {
      name: 'lab_model_default_set',
      description: 'Set the default model. You can do this. providerId and modelId must already be configured.',
      properties: { providerId: { type: 'string' }, modelId: { type: 'string' } },
      required: ['providerId', 'modelId'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        setCatalogDefaultRef(store, { providerId: str(args, 'providerId'), modelId: str(args, 'modelId') }, process.env);
        return catalogView(store);
      }
    },
    {
      name: 'lab_project_list',
      description: 'List workspace projects. You can create one with lab_project_create.',
      approval: 'never',
      async run() {
        return { projects: store.projects().list() };
      }
    },
    {
      name: 'lab_project_create',
      description: 'Create a workspace project. You can do this. Optional roots are local directories that must already exist.',
      properties: { name: { type: 'string' }, roots: { type: 'array' } },
      required: ['name'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const roots: Array<{ path: string; alias?: string; primary?: boolean }> = [];
        if (Array.isArray(args.roots)) {
          for (const item of args.roots) {
            if (!item || typeof item !== 'object') continue;
            const rec = item as Record<string, unknown>;
            const path = typeof rec.path === 'string' ? rec.path.trim() : '';
            if (!path) continue;
            const checked = await validateWorkspaceRootPath(path);
            if (!checked.ok) throw new ValidationError(checked.message);
            roots.push({
              path: checked.path,
              alias: typeof rec.alias === 'string' ? rec.alias : undefined,
              primary: rec.primary === true
            });
          }
        }
        return { project: store.projects().create({ name: str(args, 'name'), roots }) };
      }
    },
    {
      name: 'lab_project_update',
      description: 'Rename a workspace project or change its primary root. You can do this.',
      properties: { projectId: { type: 'string' }, name: { type: 'string' }, primaryRootId: { type: 'string' } },
      required: ['projectId'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const project = store.projects().update(str(args, 'projectId'), {
          name: typeof args.name === 'string' ? args.name : undefined,
          primaryRootId: typeof args.primaryRootId === 'string' ? args.primaryRootId : undefined
        });
        if (!project) throw new NotFoundError('Project', str(args, 'projectId'));
        return { project };
      }
    },
    {
      name: 'lab_project_delete',
      description: 'Delete a workspace project record. Destructive: pass confirm true. Does not delete files on disk.',
      properties: { projectId: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['projectId', 'confirm'],
      approval: 'always',
      write: true,
      confirm: 'Deleting a project',
      async run(_ctx, args) {
        const projectId = str(args, 'projectId');
        const deleted = store.projects().remove(projectId);
        if (!deleted) throw new NotFoundError('Project', projectId);
        return { deleted: true, projectId };
      }
    },
    {
      name: 'lab_goal_upsert',
      description: 'Set the active goal on a session you own. You can do this. Required: sessionId and condition.',
      properties: { sessionId: { type: 'string' }, condition: { type: 'string' }, maxTurns: { type: 'number' } },
      required: ['sessionId', 'condition'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        const session = ownSession(store, principalOf(store, ctx.session), str(args, 'sessionId'));
        const condition = str(args, 'condition');
        if (!condition) throw new ValidationError('condition is required');
        const rec = upsertGoalFromApi(store.goal(), {
          sessionId: session.id,
          condition,
          maxTurns: typeof args.maxTurns === 'number' ? args.maxTurns : undefined
        });
        store.updateSession(session.id, {
          metadata: {
            ...store.getSession(session.id)?.metadata,
            [GOAL_CONDITION_META]: rec.condition,
            [GOAL_ENABLED_META]: true,
            [GOAL_MAX_TURNS_META]: rec.maxTurns
          }
        });
        return { goal: goalWirePayload(rec) };
      }
    },
    {
      name: 'lab_goal_list',
      description: 'List goals for a session you own.',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      approval: 'never',
      async run(ctx, args) {
        const session = ownSession(store, principalOf(store, ctx.session), str(args, 'sessionId'));
        return { goals: store.goal().listBySession(session.id).map((goal) => goalWirePayload(goal)) };
      }
    },
    {
      name: 'lab_team_plan_list',
      description: 'List team plans. You can create one with lab_team_plan_create.',
      approval: 'never',
      async run() {
        return { plans: store.teams().list({ limit: 50 }) };
      }
    },
    {
      name: 'lab_team_plan_get',
      description: 'Read one team plan.',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
      approval: 'never',
      async run(_ctx, args) {
        const plan = store.teams().get(str(args, 'planId'));
        if (!plan) throw new NotFoundError('Team plan', str(args, 'planId'));
        return { plan };
      }
    },
    {
      name: 'lab_team_plan_create',
      description: 'Create a team plan from an objective. You can do this. Optional sessionId and tasks.',
      properties: { objective: { type: 'string' }, sessionId: { type: 'string' }, tasks: {} },
      required: ['objective'],
      approval: 'auto',
      write: true,
      async run(ctx, args) {
        if (!host.createTeamPlan) throw new ValidationError('Team plans are not available in this runtime');
        const sessionId = str(args, 'sessionId');
        if (sessionId) ownSession(store, principalOf(store, ctx.session), sessionId);
        const created = await host.createTeamPlan({
          objective: str(args, 'objective'),
          sessionId: sessionId || undefined,
          tasks: args.tasks
        });
        if (created.error || !created.plan) throw new ValidationError(created.error ?? 'invalid plan');
        return { plan: created.plan };
      }
    },
    {
      name: 'lab_team_plan_start',
      description: 'Start a team plan. You can do this.',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        if (!host.startTeamPlan) throw new ValidationError('Team plans are not available in this runtime');
        const plan = host.startTeamPlan(str(args, 'planId'));
        if (!plan) throw new NotFoundError('Team plan', str(args, 'planId'));
        return { plan };
      }
    },
    {
      name: 'lab_team_plan_resume',
      description: 'Resume a team plan. You can do this.',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        if (!host.resumeTeamPlan) throw new ValidationError('Team plans are not available in this runtime');
        const plan = host.resumeTeamPlan(str(args, 'planId'));
        if (!plan) throw new NotFoundError('Team plan', str(args, 'planId'));
        return { plan };
      }
    },
    {
      name: 'lab_swarm_run_list',
      description: 'List swarm runs. You can create one with lab_swarm_run_create.',
      approval: 'never',
      async run() {
        return { runs: store.swarm().listRuns({ limit: 50 }) };
      }
    },
    {
      name: 'lab_swarm_run_create',
      description: 'Create a swarm run. You can do this. Required: goal. Optional strategy and tasks (used when starting).',
      properties: { goal: { type: 'string' }, strategy: { type: 'string' } },
      required: ['goal'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const strategy = str(args, 'strategy') || 'pipeline';
        if (!SWARM_STRATEGIES.has(strategy as SwarmStrategy)) throw new ValidationError('Invalid swarm strategy');
        const run = {
          id: createSwarmId('srun'),
          goal: str(args, 'goal'),
          status: 'pending' as const,
          strategy: strategy as SwarmStrategy,
          budget: { maxTeammates: 3, maxTurnsPerAgent: 20, maxDurationMs: 600_000 },
          qualityGate: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        if (!run.goal) throw new ValidationError('goal is required');
        store.swarm().createRun(run);
        return { run };
      }
    },
    {
      name: 'lab_swarm_run_start',
      description: 'Start a pending swarm run. You can do this. Optional tasks: [{title, description, requiredRole, blockedBy}].',
      properties: { runId: { type: 'string' }, tasks: { type: 'array' } },
      required: ['runId'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        if (!host.startSwarmRun) throw new ValidationError('Swarm start is not available in this runtime');
        const tasks = Array.isArray(args.tasks)
          ? args.tasks.flatMap((item) => {
              if (!item || typeof item !== 'object') return [];
              const rec = item as Record<string, unknown>;
              const title = typeof rec.title === 'string' ? rec.title : '';
              if (!title) return [];
              return [{
                title,
                description: typeof rec.description === 'string' ? rec.description : undefined,
                requiredRole: typeof rec.requiredRole === 'string' ? rec.requiredRole as SwarmRole : undefined,
                blockedBy: Array.isArray(rec.blockedBy) ? rec.blockedBy.map(String) : undefined
              }];
            })
          : undefined;
        const run = host.startSwarmRun(str(args, 'runId'), tasks);
        if (!run) throw new ValidationError('Run not found or not pending');
        return { run };
      }
    },
    {
      name: 'lab_research_task_list',
      description: 'List research tasks. You can create one with lab_research_task_create.',
      approval: 'never',
      async run() {
        return { tasks: store.research().listTasks({ limit: 50 }) };
      }
    },
    {
      name: 'lab_research_task_create',
      description: 'Create a research task. You can do this. Required: query.',
      properties: { query: { type: 'string' }, scope: { type: 'string' } },
      required: ['query'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        return { task: store.research().createTask({ query: str(args, 'query'), scope: str(args, 'scope') || undefined }) };
      }
    },
    {
      name: 'lab_research_task_update',
      description: 'Update a research task status. You can do this.',
      properties: { taskId: { type: 'string' }, status: { type: 'string' } },
      required: ['taskId', 'status'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const status = str(args, 'status');
        if (!RESEARCH_STATUSES.has(status as ResearchStatus)) throw new ValidationError('Invalid research status');
        return { task: store.research().updateTaskStatus(str(args, 'taskId'), status as ResearchStatus) };
      }
    },
    {
      name: 'lab_orchestration_run_list',
      description: 'List orchestration runs. You can create one with lab_orchestration_run_create.',
      approval: 'never',
      async run() {
        return { runs: store.orchestrator().listRuns({ limit: 50 }) };
      }
    },
    {
      name: 'lab_orchestration_run_create',
      description: 'Create an orchestration run. You can do this. Required: title. Optional riskLevel low|medium|high.',
      properties: { title: { type: 'string' }, riskLevel: { type: 'string' }, sourceType: { type: 'string' }, sourceRef: { type: 'string' } },
      required: ['title'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const riskLevel = str(args, 'riskLevel');
        if (riskLevel && !RISK.has(riskLevel as RiskLevel)) throw new ValidationError('riskLevel must be low, medium, or high');
        const run = store.orchestrator().createRun({
          title: str(args, 'title'),
          sourceType: str(args, 'sourceType') || undefined,
          sourceRef: str(args, 'sourceRef') || undefined,
          riskLevel: riskLevel ? riskLevel as RiskLevel : undefined
        });
        return { run };
      }
    },
    {
      name: 'lab_orchestration_run_status',
      description: 'Set an orchestration run status: pending, running, waiting_approval, completed, failed, or blocked.',
      properties: { runId: { type: 'string' }, status: { type: 'string' } },
      required: ['runId', 'status'],
      approval: 'auto',
      write: true,
      async run(_ctx, args) {
        const status = str(args, 'status');
        if (!ORCH_STATUSES.has(status as OrchestrationStatus)) throw new ValidationError('Invalid orchestration status');
        return { run: store.orchestrator().updateRunStatus(str(args, 'runId'), status as OrchestrationStatus) };
      }
    }
  ];

  const published = tools.flatMap((spec) => {
    if (spec.name === 'bot_create') {
      return [spec, {
        ...spec,
        name: 'create_bot',
        description: 'Create a bot. You can do this; the tool name is create_bot. Required: name. Optional: title, description, persona, allowedTools, allowedSkills, modelOverride {providerId, modelId} for a model already configured in the lab, faceShape, faceColor, avatar, maxTurns (24|48|96). Do not send API keys, tokens, secrets, or passwords.'
      }];
    }
    if (spec.name === 'bot_room_create') {
      return [spec, {
        ...spec,
        name: 'create_room',
        description: 'Create a group chat. You can do this; the tool name is create_room. Required: title and botIds (ids or names). Optional: hostBotId, maxBotTurns (1-20), maxToolCalls, maxCostUsd.'
      }];
    }
    return [spec];
  });
  return published.map(spec => define(spec, store));
}
