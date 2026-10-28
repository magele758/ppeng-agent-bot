import { stripVisibleClockMarks } from './visible-clock';

const NO_UPDATE = '[NO_UPDATE]';
const ROUTINE_RESULT = /^\[routine:(.+)\] (\w+)\n([\s\S]*?)\nRun: (.+)$/;

/** Same rule as packages/core/src/bots/silence.ts isNoUpdateReply. */
export function isNoUpdateReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.startsWith(NO_UPDATE) || trimmed.endsWith(NO_UPDATE);
}

/** A stored routine receipt whose result is only a no-update. Real conclusions stay visible. */
export function quietRoutineResult(role: string, messageKey: string | undefined, text: string): boolean {
  if (role !== 'assistant' || !messageKey?.startsWith('routine-result:')) return false;
  const matched = ROUTINE_RESULT.exec(stripVisibleClockMarks(text));
  if (!matched?.[3]) return false;
  return isNoUpdateReply(matched[3]);
}
