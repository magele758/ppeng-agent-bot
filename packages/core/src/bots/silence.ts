/** Whole-body "nothing to add" convention shared by private chat and Rooms. */
const SILENCE_TOKENS = new Set(['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY']);

/**
 * A body that is only a silence token means the speaker has nothing to add.
 * Spacing and case do not matter; a longer sentence that merely contains the word does not match.
 */
export function isSilenceToken(body: string): boolean {
  return SILENCE_TOKENS.has(body.trim().replace(/\s+/g, ' ').toUpperCase());
}
