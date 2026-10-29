/** Whole-body "nothing to add" convention shared by private chat and Rooms. */
const SILENCE_TOKENS = new Set(['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY']);

/**
 * A body that is only a silence token means the speaker has nothing to add.
 * Spacing and case do not matter; a longer sentence that merely contains the word does not match.
 */
export function isSilenceToken(body: string): boolean {
  return SILENCE_TOKENS.has(body.trim().replace(/\s+/g, ' ').toUpperCase());
}

const NO_UPDATE = '[NO_UPDATE]';

/**
 * Routine silence. The model is told to reply with only this token when nothing changed.
 * A sentence before the token is still silence. Mentioning the token in the middle of a finding is not.
 */
export function isNoUpdateReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.startsWith(NO_UPDATE) || trimmed.endsWith(NO_UPDATE);
}
