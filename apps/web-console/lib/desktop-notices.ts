/** Notifications are a per-browser choice, tied to this origin's browser permission. */
const preference = 'lab.desktopNotices';
export function noticePermission(): NotificationPermission | 'unavailable' {
  return window.isSecureContext && 'Notification' in window ? Notification.permission : 'unavailable';
}
export function noticeSubscription(): string {
  try { return localStorage.getItem(preference) || ''; } catch { return ''; }
}
export function saveNoticeSubscription(enabled: boolean) {
  if (enabled) localStorage.setItem(preference, String(Date.now()));
  else localStorage.removeItem(preference);
}

type BotRow = {
  bot: { id: string; name: string };
  sessionId?: string;
  status?: string;
  taskCounts?: { completed?: number; waiting_approval?: number };
  tasks?: { id: string; status: string }[];
};
type Snapshot = { bots: BotRow[] };
type Kind = 'completed' | 'interaction';
export type DesktopEvent = { kind: Kind; name: string; sessionId?: string; tag: string; delegated: boolean };

function event(row: BotRow, kind: Kind, key: string | undefined, delegated: boolean): DesktopEvent {
  return { kind, name: row.bot.name, sessionId: row.sessionId, tag: JSON.stringify([row.bot.id, kind, key]), delegated };
}
function waitingTasks(row: BotRow) {
  return (row.tasks ?? []).filter(task => task.status === 'waiting_approval').map(task => task.id);
}
function completionCount(row: BotRow) {
  return row.taskCounts?.completed ?? 0;
}
function sessionEvent(before: BotRow, row: BotRow, delegatedCompletion: boolean) {
  if (row.status === before.status) return [];
  const key = row.sessionId;
  if (row.status === 'waiting_approval') return [event(row, 'interaction', key, false)];
  if (row.status === 'completed' && !delegatedCompletion) return [event(row, 'completed', key, false)];
  return [];
}
function changes(before: BotRow, row: BotRow): DesktopEvent[] {
  const total = completionCount(row);
  const completed = total > completionCount(before);
  const events = sessionEvent(before, row, completed);
  if (completed) events.push(event(row, 'completed', String(total), true));
  const previous = new Set(waitingTasks(before));
  for (const id of waitingTasks(row)) {
    if (!previous.has(id)) events.push(event(row, 'interaction', id, true));
  }
  return events;
}
function snapshotRows(payload: unknown) {
  return (payload as Snapshot | null)?.bots;
}
function changesSince(previous: Map<string, BotRow>, current: Map<string, BotRow>): DesktopEvent[] {
  const events: DesktopEvent[] = [];
  for (const [id, row] of current) {
    const before = previous.get(id);
    if (before) events.push(...changes(before, row));
  }
  return events;
}
export function desktopObserver() {
  let previous = new Map<string, BotRow>();
  let subscription = '';
  return (payload: unknown, enabled: string): DesktopEvent[] => {
    if (!enabled) { subscription = ''; previous.clear(); return []; }
    const rows = snapshotRows(payload);
    if (!Array.isArray(rows)) return [];
    if (enabled !== subscription) previous.clear();
    subscription = enabled;
    const current = new Map(rows.map(row => [row.bot.id, row]));
    const events = changesSince(previous, current);
    previous = current;
    return events;
  };
}
