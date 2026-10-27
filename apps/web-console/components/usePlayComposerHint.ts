'use client';

import { useEffect, useState } from 'react';
import {
  armComposerHint,
  COMPOSER_HINT_DELAY_MS,
  lastCompletedTurn,
  loadComposerHint,
  type ComposerHintMessage,
} from '@/lib/composer-next-hint';

export { lastCompletedTurn };

export function usePlayComposerHint(opts: {
  sessionId: string | null;
  messages: readonly ComposerHintMessage[];
  draft: string;
  enabled: boolean;
  providedHint?: string;
}): string {
  const { sessionId, messages, draft, enabled, providedHint } = opts;
  const turn = lastCompletedTurn(messages);
  const turnKey = turn && sessionId ? `${sessionId}\n${turn.userText}\n${turn.assistantText}` : '';
  const [hintState, setHintState] = useState<{ key: string; hint: string }>({ key: '', hint: '' });

  useEffect(() => {
    if (providedHint !== undefined || !enabled || draft.trim() || !turnKey || !sessionId) {
      if (providedHint === undefined) {
        setHintState((current) => (current.hint === '' && current.key === turnKey ? current : { key: turnKey, hint: '' }));
      }
      return;
    }
    const controller = new AbortController();
    const cancel = armComposerHint({
      delayMs: COMPOSER_HINT_DELAY_MS,
      schedule: (fn, ms) => {
        const id = window.setTimeout(fn, ms);
        return () => window.clearTimeout(id);
      },
      load: () => loadComposerHint(sessionId, controller.signal),
      publish: (hint) => {
        if (!controller.signal.aborted) setHintState({ key: turnKey, hint });
      },
    });
    return () => {
      controller.abort();
      cancel();
    };
  }, [draft, enabled, providedHint, sessionId, turnKey]);

  if (providedHint !== undefined) return draft.trim() ? '' : providedHint;
  if (!enabled || draft.trim()) return '';
  return hintState.key === turnKey ? hintState.hint : '';
}
