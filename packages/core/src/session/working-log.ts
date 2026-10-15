import {
  readWorkingLogTail,
  workingLogEnabled,
  workingLogPath,
  workingLogTailChars
} from '@ppeng/agent-loop/session';

export {
  WORKING_LOG_FILENAME,
  appendWorkingLogEntry,
  readWorkingLogTail,
  workingLogEnabled,
  workingLogPath,
  workingLogTailChars
} from '@ppeng/agent-loop/session';
export type { WorkingLogEntry, WorkingLogEntryKind } from '@ppeng/agent-loop/session';

/** Same user-side fallback the turn kernel appends when the memory pack is empty. */
export function readWorkingLogAppendix(
  stateDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!workingLogEnabled(env)) return '';
  const body = readWorkingLogTail(workingLogPath(stateDir, sessionId), workingLogTailChars(env)).trim();
  if (!body) return '';
  return `[working log — durable trail across compaction; full transcripts at the referenced paths]\n${body}`;
}
