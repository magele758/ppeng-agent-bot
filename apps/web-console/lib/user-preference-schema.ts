export type UserPreferences = Record<string, string | null>;
const keys = new Set(['theme','lab.locale','lab.skin','lab.fontSize','lab.debugDisplay','lab.settings.advanced','agentLab.sendAckSound','lab.sessionBrief','lab.botFirstTaskSent','lab.botFirstTaskDismissed']);
const prefixes = ['lab.botFirstTaskDismissed.','lab.skillCaptureDismissed.','lab.skillOperationDismissed.'];
export function isUserPreferenceKey(key: string): boolean {
 return keys.has(key) || prefixes.some(prefix => key.startsWith(prefix));
}
export function mergePreferences(current: UserPreferences, incoming: UserPreferences, initialize: boolean): UserPreferences {
 const next = {...current};
 for (const [key,value] of Object.entries(incoming)) {
  if (!isUserPreferenceKey(key)) throw new Error('Unknown preference');
  if (initialize && Object.hasOwn(current,key)) continue;
  next[key] = value;
 }
 return next;
}
