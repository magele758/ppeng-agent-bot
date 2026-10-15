export interface ListLoadState {
  loaded: boolean;
  error: boolean;
}

export type LabListKey =
  | 'tasks'
  | 'socialSchedules'
  | 'approvals'
  | 'outboundDrafts'
  | 'jobs'
  | 'workspaces'
  | 'mail'
  | 'swarmRuns'
  | 'orchestrationRuns';

export type LabListState = Record<LabListKey, ListLoadState>;

const IDLE: ListLoadState = { loaded: false, error: false };

export function idleLabListState(): LabListState {
  return {
    tasks: { ...IDLE },
    socialSchedules: { ...IDLE },
    approvals: { ...IDLE },
    outboundDrafts: { ...IDLE },
    jobs: { ...IDLE },
    workspaces: { ...IDLE },
    mail: { ...IDLE },
    swarmRuns: { ...IDLE },
    orchestrationRuns: { ...IDLE }
  };
}

export type ListFetch<T> = { ok: true; items: T[] } | { ok: false };

/** Keep the previous rows when a list request fails; record that the request failed. */
export function settleList<T>(
  current: readonly T[],
  state: ListLoadState,
  fetched: ListFetch<T>
): { items: T[]; state: ListLoadState } {
  if (!fetched.ok) return { items: [...current], state: { loaded: state.loaded, error: true } };
  return { items: fetched.items, state: { loaded: true, error: false } };
}

export async function fetchList<T>(load: () => Promise<T[]>): Promise<ListFetch<T>> {
  try {
    return { ok: true, items: await load() };
  } catch {
    return { ok: false };
  }
}
