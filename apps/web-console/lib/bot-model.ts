import {
  encodeModelValue,
  isEnvFallbackOption,
  parseSessionModelRef,
  resolvePickerModelRef,
  type ModelPickerOption,
  type ModelRef
} from './model-providers.ts';

/** Bot chats store the pin as `metadata.modelOverride`; absent means "follow the default". */
export function parseBotModelOverride(
  metadata: Record<string, unknown> | undefined
): ModelRef | null {
  const raw = metadata?.modelOverride;
  return parseSessionModelRef({ modelRef: raw }) ?? null;
}

export type BotModelChoice = { value: string; ref: ModelRef | null };

export const BOT_MODEL_FOLLOW_DEFAULT = '';

/** Dropdown values: '' for follow-default, else `providerId::modelId`. Env fallback is never offered. */
export function botModelSelectValue(pinned: ModelRef | null): string {
  return pinned ? encodeModelValue(pinned) : BOT_MODEL_FOLLOW_DEFAULT;
}

export function botModelPickable(options: readonly ModelPickerOption[]): ModelPickerOption[] {
  return options.filter((o) => !isEnvFallbackOption(o));
}

/** True when a saved pin no longer matches any selectable model (provider removed / model disabled). */
export function botModelPinIsStale(
  pinned: ModelRef | null,
  options: readonly ModelPickerOption[]
): boolean {
  if (!pinned) return false;
  return !botModelPickable(options).some(
    (o) => o.providerId === pinned.providerId && o.modelId === pinned.modelId
  );
}

function composerSessionModelRef(metadata: Record<string, unknown> | undefined): ModelRef | null {
  if (metadata?.canonicalBotChat === true) return null;
  return parseSessionModelRef(metadata);
}

function composerModelWithoutSelection(input: {
  metadata: Record<string, unknown> | undefined;
  sameSession: boolean;
  pinLifted: boolean;
  current: ModelRef | null;
}): ModelRef | null {
  if (input.metadata?.canonicalBotChat === true) return null;
  return input.sameSession && !input.pinLifted ? input.current : null;
}

/** Bot chats follow their Bot pin or the current default. Ordinary chats retain their own selection. */
export function resolveLoadedComposerModelRef(input: {
  metadata: Record<string, unknown> | undefined;
  options: readonly ModelPickerOption[];
  catalogDefault: ModelRef | null;
  current: ModelRef | null;
  sameSession: boolean;
  pinLifted: boolean;
}): ModelRef | null {
  const pin = parseBotModelOverride(input.metadata);
  const own = pin ?? composerSessionModelRef(input.metadata);
  if (own && !(input.pinLifted && !pin)) {
    return resolvePickerModelRef(input.options, own, input.catalogDefault);
  }
  return composerModelWithoutSelection(input);
}

/** The composer picker is locked by the session's own pin (bot chats and forks alike). */
export function composerModelLocked(sessionPin: ModelRef | null): boolean {
  return sessionPin !== null;
}
