/** Shared by RoutineRuns and other Bot work panels; unrecognized states fail closed. */
const known = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'unknown', 'skipped', 'silent', 'idle', 'active', 'paused', 'configured', 'ready', 'degraded', 'unavailable'] as const;
type Status = typeof known[number];
const colors: Partial<Record<Status, { color: string; backgroundColor: string; borderStyle: 'solid' | 'dashed' | 'dotted' }>> = {
  silent: { color: '#4c3b80', backgroundColor: '#eee9f7', borderStyle: 'dotted' },
  skipped: { color: '#485361', backgroundColor: '#eef0f3', borderStyle: 'dashed' },
  unknown: { color: '#774b00', backgroundColor: '#fff0c2', borderStyle: 'solid' },
  completed: { color: '#17613b', backgroundColor: '#e3f4e9', borderStyle: 'solid' },
};
export function routineStatusPresentation(value: string) {
  const status: Status = known.includes(value as Status) ? value as Status : 'unknown';
  return {
    key: `botWork.states.${status}` as const,
    status,
    style: { borderWidth: '1px', borderRadius: '4px', padding: '1px 6px', ...(colors[status] ?? { borderStyle: 'solid' as const }) },
  };
}
