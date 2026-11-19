/**
 * Who may change a Bot's model and thinking effort pins: its owner or an
 * administrator. A Bot without an owner (installed with the product, or a
 * legacy row whose owner was never recorded) is administrator-only.
 * Every pin write path asks permittedBotPinPatch, so the rule lives here once.
 */

import { sessionOwnerId } from '../auth/session-access.js';
import { AuthorizationError } from '../errors.js';
import { parseModelRef, pickerOptions, readModelCatalog, type ModelRef } from '../model/provider-catalog.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';
import { parseBotChatCommand, resolveBotModelArg } from './bot-chat-commands.js';
import { botDefinitionOwner, resolveBotPrincipal, sameBotPrincipal, type BotPrincipal } from './bot-identity.js';
import { readBotModelOverride } from './bot-model.js';
import { readBotThinkingEffort } from './bot-thinking-effort.js';
import type { BotRecord, UpdateBotInput } from './types.js';

export const BOT_PIN_FORBIDDEN = 'bot_pin_forbidden';

/** Owner of a Bot definition as the access checks see it. */
export type BotOwnership =
  | { kind: 'missing' }
  | { kind: 'owned'; userId: string }
  /** Installed with the product, or a legacy row whose canonical chat names no user. */
  | { kind: 'shared' }
  /** Legacy row whose canonical chat (the only owner evidence) is gone. */
  | { kind: 'unknown' };

export interface BotPinCaller {
  userId?: string;
  /** Tenant owner / admin, the installation itself, or the operator when Lab login is off. */
  admin: boolean;
}

export type BotPinField = 'modelOverride' | 'thinkingEffort';

const PIN_FIELDS: readonly BotPinField[] = ['modelOverride', 'thinkingEffort'];
const MISSING: BotOwnership = { kind: 'missing' };
const SHARED: BotOwnership = { kind: 'shared' };
const UNKNOWN: BotOwnership = { kind: 'unknown' };

export function botOwnership(store: SqliteStateStore, botId: string | undefined): BotOwnership {
  const bot = botId ? store.getBot(botId) : undefined;
  if (!bot) return MISSING;
  const definitionOwner = botDefinitionOwner(store, bot.id);
  if (definitionOwner) return definitionOwnership(store, definitionOwner);
  return legacyOwnership(store, store.getSession(bot.canonicalSessionId));
}

function definitionOwnership(store: SqliteStateStore, owner: BotPrincipal): BotOwnership {
  return sameBotPrincipal(owner, resolveBotPrincipal(store)) ? SHARED : { kind: 'owned', userId: owner.userId };
}

function legacyOwnership(store: SqliteStateStore, canonical: SessionRecord | undefined): BotOwnership {
  if (!canonical) return UNKNOWN;
  const ownerId = sessionOwnerId(canonical);
  if (!ownerId || installedBy(store, ownerId, canonical)) return SHARED;
  return { kind: 'owned', userId: ownerId };
}

function installedBy(store: SqliteStateStore, ownerId: string, canonical: SessionRecord): boolean {
  return ownerId === resolveBotPrincipal(store).userId && !canonical.metadata?.tenantId;
}

export function mayChangeBotPins(store: SqliteStateStore, botId: string, caller: BotPinCaller): boolean {
  if (caller.admin) return true;
  const ownership = botOwnership(store, botId);
  return ownership.kind === 'owned' && ownership.userId === caller.userId;
}

function clearsPin(raw: unknown): boolean {
  return raw === null || raw === '';
}

function sameModelRef(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  if (!left || !right) return false;
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

/** Unreadable input never matches, so it counts as a change. */
function keepsModelPin(saved: Record<string, unknown> | undefined, raw: unknown): boolean {
  const pinned = readBotModelOverride(saved);
  if (clearsPin(raw)) return pinned === undefined;
  return sameModelRef(parseModelRef(raw), pinned);
}

function keepsEffortPin(saved: Record<string, unknown> | undefined, raw: unknown): boolean {
  const pinned = readBotThinkingEffort(saved);
  if (clearsPin(raw)) return pinned === undefined;
  return raw === pinned;
}

function keepsPin(field: BotPinField, saved: Record<string, unknown> | undefined, raw: unknown): boolean {
  return field === 'modelOverride' ? keepsModelPin(saved, raw) : keepsEffortPin(saved, raw);
}

/** Pin fields of `patch` that would change what the Bot has saved. `undefined` leaves a pin alone. */
export function changedBotPins(store: SqliteStateStore, bot: BotRecord, patch: UpdateBotInput): BotPinField[] {
  const saved = store.getSession(bot.canonicalSessionId)?.metadata;
  return PIN_FIELDS.filter((field) => patch[field] !== undefined && !keepsPin(field, saved, patch[field]));
}

function withoutPins<T extends UpdateBotInput>(patch: T): T {
  const { modelOverride: _model, thinkingEffort: _effort, ...rest } = patch;
  return rest as T;
}

/**
 * The pin edits this caller may apply. Throws when `patch` would change a pin
 * and the caller is neither the Bot's owner nor an administrator. Such a caller
 * may still repeat the saved values; those fields are dropped so nothing is rewritten.
 */
export function permittedBotPinPatch<T extends UpdateBotInput>(
  store: SqliteStateStore,
  botId: string,
  patch: T,
  caller: BotPinCaller
): T {
  const bot = store.getBot(botId);
  if (!bot || mayChangeBotPins(store, bot.id, caller)) return patch;
  if (changedBotPins(store, bot, patch).length > 0) throw new AuthorizationError(BOT_PIN_FORBIDDEN);
  return withoutPins(patch);
}

/** The model pin a `/model` chat command asks for; empty when the command would not save one. */
export function botChatCommandPinPatch(store: SqliteStateStore, text: string): UpdateBotInput {
  const parsed = parseBotChatCommand(text);
  if (parsed?.command !== 'model') return {};
  const resolved = resolveBotModelArg(parsed.arg, pickerOptions(readModelCatalog(store), process.env));
  if (!resolved.ok || resolved.kind === 'usage') return {};
  return { modelOverride: resolved.kind === 'clear' ? null : resolved.modelOverride };
}
