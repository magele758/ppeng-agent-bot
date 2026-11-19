import type { PendingContextSource } from './composer-context';

/** Unsent composer state that belongs to one conversation. Kept in memory only; a reload starts empty. */
export type ComposerDraft = {
  text: string;
  imageAssetIds: string[];
  attachmentIds: string[];
  context: PendingContextSource[];
};

/** Where the composer points: the draft key plus the bot that owns a not-yet-opened bot session. */
export type ComposerDraftSpot = { key: string; botId: string };

export type ComposerDraftIo = {
  read: () => ComposerDraft;
  apply: (draft: ComposerDraft) => void;
  leave: () => void;
};

const NEW_PREFIX = 'new:';

export function emptyComposerDraft(): ComposerDraft {
  return { text: '', imageAssetIds: [], attachmentIds: [], context: [] };
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return !draft.text && !draft.imageAssetIds.length && !draft.attachmentIds.length && !draft.context.length;
}

/** A session id names its own draft; before a session exists, each surface and bot has one "new" slot. */
export function composerDraftKey(args: { sessionId: string | null; surface: string; botId: string }): string {
  return args.sessionId ? `session:${args.sessionId}` : `${NEW_PREFIX}${args.surface}:${args.botId}`;
}

/** While opening a remembered Bot, its draft belongs to that Bot before the server supplies a session id. */
export function composerDraftSpot(args: { sessionId: string | null; surface: string; botId: string; openingBotId: string }): ComposerDraftSpot {
  const botId = args.botId || args.openingBotId;
  return { key: composerDraftKey({ ...args, botId }), botId };
}

/** Text typed while a session is being created (by this send, or a bot opening) belongs to the session that just appeared. */
function draftFollows(from: ComposerDraftSpot, to: ComposerDraftSpot, claimed: boolean): boolean {
  if (!from.key.startsWith(NEW_PREFIX) || to.key.startsWith(NEW_PREFIX)) return false;
  return from.botId ? from.botId === to.botId : claimed;
}

export function createComposerDraftScope(first: ComposerDraftSpot) {
  const saved = new Map<string, ComposerDraft>();
  let at = first;

  const restore = (to: ComposerDraftSpot): ComposerDraft => {
    const pending = to.botId && !to.key.startsWith(NEW_PREFIX)
      ? composerDraftKey({ sessionId: null, surface: 'bot', botId: to.botId })
      : to.key;
    const draft = saved.get(to.key) ?? saved.get(pending) ?? emptyComposerDraft();
    saved.delete(to.key);
    saved.delete(pending);
    return draft;
  };

  const stash = (key: string, draft: ComposerDraft) => {
    if (isEmptyDraft(draft)) saved.delete(key);
    else saved.set(key, draft);
  };

  return {
    move(to: ComposerDraftSpot, state: { claimed: boolean }, io: ComposerDraftIo): void {
      const from = at;
      if (from.key === to.key) return;
      at = to;
      io.leave();
      const current = io.read();
      if (draftFollows(from, to, state.claimed) && !saved.has(to.key)) {
        saved.delete(from.key);
        io.apply(current);
        return;
      }
      stash(from.key, current);
      io.apply(restore(to));
    }
  };
}
