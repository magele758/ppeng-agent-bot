import { stripVisibleClockMarks } from './visible-clock';

const NO_UPDATE = '[NO_UPDATE]';
const ROUTINE_RESULT = /^\[routine:(.+)\] (\w+)\n([\s\S]*?)\nRun: (.+)$/;

/** Same rule as packages/core/src/bots/silence.ts isNoUpdateReply. */
export function isNoUpdateReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.startsWith(NO_UPDATE) || trimmed.endsWith(NO_UPDATE);
}

/** A routine receipt, or the routine's own reply, when it only says nothing changed. */
export function quietRoutineResult(role: string, messageKey: string | undefined, text: string): boolean {
  if (role !== 'assistant') return false;
  const body = stripVisibleClockMarks(text);
  if (messageKey?.startsWith('routine-result:')) {
    const matched = ROUTINE_RESULT.exec(body);
    if (matched?.[3]) return isNoUpdateReply(matched[3]);
  }
  return isNoUpdateReply(body);
}
