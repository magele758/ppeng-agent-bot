import { resolveBotPrincipal, principalFromSession, sameBotPrincipal, setBotDefinitionOwner, botDefinitionOwner } from './bot-identity.js';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { createId, nowIso } from '../id.js';
import type { SessionFacadeHost } from '../runtime/session-facade.js';
import { createChatSession, ensureAgent } from '../runtime/session-facade.js';
import { parseSessionMaxTurns } from '../runtime/session-max-turns.js';
import type { AgentSpec, SessionRecord } from '../types.js';
import type { SqliteStateStore } from '../storage.js';
import { normalizeAllowedSkillNames, readAllowedSkillNames } from '../skills/skill-allowlist.js';
import { normalizeAllowedToolNames, readPositiveAllowedTools } from './bot-policy.js';
import { faceUpdatePatch, normalizeBotAvatar, normalizeBotFaceColor, normalizeBotFaceShape } from './bot-appearance.js';
import {
  BOT_MODEL_OVERRIDE_META,
  normalizeBotModelOverride,
  readBotModelOverride
} from './bot-model.js';
import {
  BOT_DEFAULT_MAX_TURNS,
  BOT_DEFAULT_PERMISSION_MODE,
  BOT_DESCRIPTION_MAX,
  BOT_NAME_MAX,
  BOT_ROSTER_CAP,
  BOT_TITLE_MAX,
  CANONICAL_BOT_CHAT_META,
  SESSION_CUT_META,
  type BotRecord,
  type CreateBotInput,
  type ListBotsOptions,
  type OpenBotResult,
  type UpdateBotInput
} from './types.js';

export function slugifyBotName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (/^[a-z][a-z0-9-]{1,47}$/.test(slug)) return slug;
  return '';
}

export function canonicalBotChatTitle(name: string): string {
  return `Bot Chat · ${name}`;
}

export function botInstructions(input: { name: string; title: string; description: string; persona?: string }): string {
  const bits = [
    `You are ${input.name}${input.title && input.title !== input.name ? ` (${input.title})` : ''}.`,
    input.description.trim(),
    input.persona?.trim() ? `Persona: ${input.persona.trim()}` : '',
    'You are a named persistent teammate. Continue this conversation; do not treat it as a disposable chat.',
    'You choose the execution style for each request — do not ask the user to pick Chat / Task / Orchestrator / Self-Heal / Planner / Generator / Evaluator.',
    'Q&A: answer directly. Multi-step or implementation: TodoWrite, tools, task_create. Cross-cutting work: orchestrate teammates or spawn_subagent. Research/plan/implement/review as the task requires.',
    "Whether a tool call needs approval is decided by this session's permissionMode.",
    'You can create bots and group chats (可以创建 bot 和群聊) with create_bot and create_room. The same actions are also available as bot_create, bot_update, bot_room_create, bot_room_update, and lab_settings_update when they are in your tool list. Do not claim you lack that ability. Deleting a group chat, member, session, or provider needs confirm: true and approval. Never repeat API keys or tokens. Do not read secrets; reference a model already configured in the lab. Do not approve tool calls or outbound drafts for the user.',
    'This is a long-lived conversation. Older turns are compacted and keyframes are kept (session cut); do not ask the user to start a new chat.'
  ].filter(Boolean);
  return bits.join('\n');
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ValidationError('name is required');
  if (name.length > BOT_NAME_MAX) throw new ValidationError(`name must be ≤ ${BOT_NAME_MAX} characters`);
  return name;
}

function normalizeTitle(raw: string | undefined, fallback: string): string {
  const title = (raw ?? '').trim() || fallback;
  if (title.length > BOT_TITLE_MAX) throw new ValidationError(`title must be ≤ ${BOT_TITLE_MAX} characters`);
  return title;
}

function normalizeDescription(raw: string | undefined): string {
  const description = (raw ?? '').trim();
  if (description.length > BOT_DESCRIPTION_MAX) {
    throw new ValidationError(`description must be ≤ ${BOT_DESCRIPTION_MAX} characters`);
  }
  return description;
}

function allocateBotId(store: SqliteStateStore, name: string): string {
  const slug = slugifyBotName(name);
  if (slug && !store.getBot(slug) && !store.getAgent(slug)) return slug;
  return createId('bot');
}

function readPersona(metadata: Record<string, unknown> | undefined): string | undefined {
  const persona = metadata?.persona;
  return typeof persona === 'string' && persona.trim() ? persona.trim() : undefined;
}

function botAgentSpec(
  bot: Pick<BotRecord, 'id' | 'name' | 'title' | 'description'>,
  allowedTools?: string[],
  persona?: string
): AgentSpec {
  return {
    id: bot.id,
    name: bot.name,
    role: bot.title || 'Bot',
    instructions: botInstructions({ ...bot, persona }),
    capabilities: ['bot', 'tool-use', 'task-management', 'orchestration'],
    autonomous: true,
    domainId: 'bot',
    ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {})
  };
}

function refreshBotAgent(host: SessionFacadeHost, bot: BotRecord): void {
  const session = host.store.getSession(bot.canonicalSessionId);
  host.store.upsertAgent(botAgentSpec(bot, readPositiveAllowedTools(session?.metadata), readPersona(session?.metadata)));
}

/** Rewrite stored bot agent instructions so existing bots pick up capability text after an upgrade. */
export function syncBotAgentSpecs(store: SqliteStateStore): void {
  for (const bot of store.listBots({ includeHidden: true })) {
    const session = store.getSession(bot.canonicalSessionId);
    store.upsertAgent(botAgentSpec(bot, readPositiveAllowedTools(session?.metadata), readPersona(session?.metadata)));
  }
}

function savedMaxTurns(metadata: Record<string, unknown> | undefined): number | undefined {
  const raw = metadata?.maxTurns;
  if (raw === 24 || raw === 48 || raw === 96) return raw;
  return undefined;
}

function listBotChats(store: SqliteStateStore, bot: BotRecord): SessionRecord[] {
  const seen = new Set<string>();
  const out: SessionRecord[] = [];
  const push = (session: SessionRecord | undefined) => {
    if (!session || seen.has(session.id)) return;
    seen.add(session.id);
    out.push(session);
  };
  push(store.getSession(bot.canonicalSessionId));
  for (const session of store.listSessions()) {
    if (
      session.metadata?.botId === bot.id &&
      session.metadata?.[CANONICAL_BOT_CHAT_META] === true
    ) {
      push(session);
    }
  }
  return out;
}

function createCanonicalSession(
  host: SessionFacadeHost,
  bot: Pick<BotRecord, 'id' | 'name'> & { canonicalSessionId?: string },
  owner?: { userId?: string; tenantId?: string }
): SessionRecord {
  const prior = bot.canonicalSessionId
    ? host.store.getSession(bot.canonicalSessionId)
    : undefined;
  const inheritedTools = readPositiveAllowedTools(prior?.metadata);
  const inheritedSkills = readAllowedSkillNames(prior?.metadata);
  const inheritedModel = readBotModelOverride(prior?.metadata);
  return createChatSession(host, {
    title: canonicalBotChatTitle(bot.name),
    agentId: bot.id,
    background: false,
    metadata: {
      botId: bot.id,
      [CANONICAL_BOT_CHAT_META]: true,
      [SESSION_CUT_META]: true,
      permissionMode: BOT_DEFAULT_PERMISSION_MODE,
      maxTurns: savedMaxTurns(prior?.metadata) ?? BOT_DEFAULT_MAX_TURNS,
      ...(inheritedTools ? { allowedTools: inheritedTools } : {}),
      ...(inheritedSkills ? { allowedSkills: inheritedSkills } : {}),
      ...(inheritedModel ? { [BOT_MODEL_OVERRIDE_META]: inheritedModel } : {}),
      ...resolveBotPrincipal(host.store, owner)
    }
  });
}

/** Fill auto only when permissionMode is absent. Never rewrite ask / plan / bypass. */
function ensureBotPermissionMode(host: SessionFacadeHost, sessionId: string): void {
  const session = host.store.getSession(sessionId);
  if (!session) return;
  const current = session.metadata?.permissionMode;
  if (typeof current === 'string' && current.trim()) return;
  host.store.updateSession(sessionId, {
    metadata: { ...session.metadata, permissionMode: BOT_DEFAULT_PERMISSION_MODE }
  });
}

function ensureBotSessionCut(host: SessionFacadeHost, sessionId: string): void {
  const session = host.store.getSession(sessionId);
  if (!session || session.metadata?.[SESSION_CUT_META] === true) return;
  host.store.updateSession(sessionId, {
    metadata: { ...session.metadata, [SESSION_CUT_META]: true }
  });
}

/** A blank user id is unowned. It is not the installer principal. */
function recordedCanonicalUserId(session: { metadata?: Record<string, unknown> } | undefined): string | undefined {
  const raw = session?.metadata?.userId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function listBots(store: SqliteStateStore, opts?: ListBotsOptions): BotRecord[] {
  return store.listBots(opts);
}

export function getBot(store: SqliteStateStore, id: string): BotRecord {
  const bot = store.getBot(id);
  if (!bot) throw new NotFoundError('Bot', id);
  return bot;
}

export function createBot(host: SessionFacadeHost, input: CreateBotInput, options?: { builtin?: boolean }): BotRecord {
  const faceShape = normalizeBotFaceShape(input.faceShape);
  const faceColor = normalizeBotFaceColor(input.faceColor);
  const avatar = normalizeBotAvatar(input.avatar);
  const name = normalizeName(input.name);
  const title = normalizeTitle(input.title, name);
  const description = normalizeDescription(input.description);
  if (host.store.getBotByName(name)) {
    throw new ConflictError(`Bot name already exists: ${name}`);
  }
  const builtinId = host.store.getDaemonControl<string>('bot.superBotId');
  const ordinaryCount = host.store.countBots({ includeHidden: true }) - (builtinId && host.store.getBot(builtinId) ? 1 : 0);
  if (!options?.builtin && ordinaryCount >= BOT_ROSTER_CAP) {
    throw new ValidationError(`Bot roster cap reached (${BOT_ROSTER_CAP})`);
  }

  const id = allocateBotId(host.store, name);
  const draft: Pick<BotRecord, 'id' | 'name' | 'title' | 'description'> = {
    id,
    name,
    title,
    description
  };
  ensureAgent(host.store, botAgentSpec(draft));
  const session = createCanonicalSession(host, draft);
  const now = nowIso();
  const created = host.store.createBot({
    id,
    name,
    title,
    description,
    agentId: id,
    canonicalSessionId: session.id,
    hidden: false,
    faceShape,
    faceColor,
    avatar,
    createdAt: now,
    updatedAt: now
  });
  setBotDefinitionOwner(host.store,id,resolveBotPrincipal(host.store));
  return created;
}

export function updateBot(
  host: SessionFacadeHost,
  id: string,
  patch: UpdateBotInput,
  opts?: {
    toolCatalog?: readonly { name: string }[];
    /** Saved PTC dynamic tool names for this bot; valid allowlist entries outside the catalog. */
    dynToolNames?: readonly string[];
    skillCatalog?: readonly { name: string }[];
    modelOptions?: readonly { providerId: string; modelId: string }[];
  }
): BotRecord {
  const current = getBot(host.store, id);
  const maxTurns = patch.maxTurns !== undefined ? parseSessionMaxTurns(patch.maxTurns) : undefined;
  const hasAllowedTools = patch.allowedTools !== undefined;
  let allowedTools: string[] | undefined;
  if (hasAllowedTools) {
    if (!opts?.toolCatalog) {
      throw new ValidationError('allowedTools requires a tool catalog');
    }
    allowedTools = normalizeAllowedToolNames(patch.allowedTools, opts.toolCatalog, opts.dynToolNames);
  }
  const hasAllowedSkills = patch.allowedSkills !== undefined;
  let allowedSkills: string[] | undefined;
  if (hasAllowedSkills) {
    if (!opts?.skillCatalog) {
      throw new ValidationError('allowedSkills requires a skill catalog');
    }
    allowedSkills = normalizeAllowedSkillNames(patch.allowedSkills, opts.skillCatalog);
  }
  const hasModelOverride = patch.modelOverride !== undefined;
  let modelOverride: ReturnType<typeof normalizeBotModelOverride> = null;
  if (hasModelOverride) {
    if (!opts?.modelOptions) {
      throw new ValidationError('modelOverride requires a model catalog');
    }
    modelOverride = normalizeBotModelOverride(patch.modelOverride, opts.modelOptions);
  }
  const name = patch.name !== undefined ? normalizeName(patch.name) : current.name;
  if (name !== current.name) {
    const taken = host.store.getBotByName(name);
    if (taken && taken.id !== id) throw new ConflictError(`Bot name already exists: ${name}`);
  }
  const title = patch.title !== undefined ? normalizeTitle(patch.title, name) : current.title;
  const description =
    patch.description !== undefined ? normalizeDescription(patch.description) : current.description;
  const next = host.store.updateBot(id, {
    name,
    title,
    description,
    hidden: patch.hidden,
    ...faceUpdatePatch(patch)
  });
  if (name !== current.name || title !== current.title) {
    for (const session of listBotChats(host.store, next)) {
      host.store.updateSession(session.id, {
        title: canonicalBotChatTitle(next.name)
      });
    }
  }
  if (maxTurns !== undefined || hasAllowedTools || hasAllowedSkills || hasModelOverride) {
    const metaPatch: Record<string, unknown> = {};
    if (maxTurns !== undefined) metaPatch.maxTurns = maxTurns;
    if (hasAllowedTools) metaPatch.allowedTools = allowedTools ?? [];
    if (hasAllowedSkills) metaPatch.allowedSkills = allowedSkills ?? [];
    for (const session of listBotChats(host.store, next)) {
      const metadata = { ...session.metadata, ...metaPatch };
      if (hasModelOverride) {
        if (modelOverride) metadata[BOT_MODEL_OVERRIDE_META] = modelOverride;
        else delete metadata[BOT_MODEL_OVERRIDE_META];
      }
      host.store.updateSession(session.id, { metadata });
    }
  }
  refreshBotAgent(host, next);
  return next;
}

export function openBot(
  host: SessionFacadeHost,
  id: string,
  opts?: { userId?: string; tenantId?: string }
): OpenBotResult {
  const bot = getBot(host.store, id);
  refreshBotAgent(host, bot);
  const principal = resolveBotPrincipal(host.store, opts);
  const installation = resolveBotPrincipal(host.store);
  const existing = host.store.getSession(bot.canonicalSessionId);
  // Ownerless legacy chats stay unowned until an explicit claim. Opening one must
  // not adopt the installer principal or clone its allowlist into another login's chat.
  if (existing && !recordedCanonicalUserId(existing)) {
    if (existing.agentId !== bot.id) throw new ValidationError('Invalid Bot canonical binding');
    if (!sameBotPrincipal(principal, installation)) {
      throw new AuthorizationError('Bot ownership is unknown for this principal');
    }
    ensureBotPermissionMode(host, existing.id);
    ensureBotSessionCut(host, existing.id);
    return { bot, sessionId: existing.id, createdSession: false };
  }
  const canonical = host.store.getSession(bot.canonicalSessionId);
  const owner = canonical ? principalFromSession(host.store, canonical) : botDefinitionOwner(host.store,bot.id);
  if(!canonical&&!owner&&!sameBotPrincipal(principal,installation))throw new AuthorizationError('Bot ownership is unknown for this principal');
  if(owner && !sameBotPrincipal(owner,installation) && !sameBotPrincipal(owner,principal))throw new AuthorizationError('Bot belongs to another principal');
  if(canonical && canonical.agentId !== bot.id) throw new ValidationError('Invalid Bot canonical binding');
  if (canonical && !sameBotPrincipal(principalFromSession(host.store, canonical), installation) &&
      !sameBotPrincipal(principalFromSession(host.store, canonical), principal)) {
    throw new AuthorizationError('Bot belongs to another principal');
  }
  const mine = host.store.listSessions().find(session =>
    session.metadata?.botId === bot.id && session.metadata?.[CANONICAL_BOT_CHAT_META] === true &&
    sameBotPrincipal(principalFromSession(host.store, session), principal));
  if (mine && (canonical || !sameBotPrincipal(principal, installation))) {
    ensureBotPermissionMode(host, mine.id); ensureBotSessionCut(host, mine.id);
    return { bot, sessionId: mine.id, createdSession: false };
  }
  const session = createCanonicalSession(host, bot, principal);
  if (sameBotPrincipal(principal, installation) || (owner && sameBotPrincipal(owner, principal))) host.store.updateBot(bot.id, { canonicalSessionId: session.id });
  return { bot: host.store.getBot(bot.id)!, sessionId: session.id, createdSession: true };
}

export function resolveBotIdFromBody(body: Record<string, unknown>): string | undefined {
  const raw = typeof body.botId === 'string' ? body.botId.trim() : '';
  return raw || undefined;
}
