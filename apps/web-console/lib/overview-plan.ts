import type { ListFetch, LabListKey } from './list-load.ts';
import { fetchList, SKIPPED_LIST } from './list-load.ts';

/** How often a timer refresh re-reads data that rarely changes. */
export const META_REFRESH_MS = 30_000;
export const AGENTS_REFRESH_MS = 30_000;

type Read = (path: string) => Promise<unknown>;

export interface OverviewLocation {
  section: string;
  sub: string | null;
}

/** The sidebar badge needs pending approvals on every page. */
const ALWAYS: readonly LabListKey[] = ['approvals'];

const BY_PAGE: Record<string, readonly LabListKey[]> = {
  'tasks/queue': ['tasks', 'socialSchedules', 'jobs'],
  'tasks/runs': ['orchestrationRuns', 'swarmRuns'],
  'tasks/inbox': ['workspaces', 'mail', 'outboundDrafts'],
  'agents/teams': ['mail', 'swarmRuns']
};

/** `tasks` with no sub page shows the queue. */
const DEFAULT_SUB: Record<string, string> = { tasks: 'queue', agents: 'bots' };

/** Overview lists the page at `location` displays. */
export function overviewListsFor(location: OverviewLocation): ReadonlySet<LabListKey> {
  const sub = location.sub ?? DEFAULT_SUB[location.section] ?? '';
  return new Set([...ALWAYS, ...(BY_PAGE[`${location.section}/${sub}`] ?? [])]);
}

/** Pages that list agents get them on every refresh. */
function showsAgents(location: OverviewLocation): boolean {
  return location.section === 'agents' || location.section === 'tasks';
}

export interface OverviewPlan {
  /** Joins a pending timer read for timer refreshes; always a new request after an event. */
  read: Read;
  list: <T>(key: LabListKey, load: () => Promise<T[]>) => Promise<ListFetch<T>>;
  /** Resolves `{}` when agents are not due. */
  agents: () => Promise<unknown>;
}

export interface OverviewCadence {
  /** The refresh timer calls this just before it refreshes. */
  markTimer: () => void;
  clearTimer: () => void;
  /** Whether version and health should be read on this refresh. */
  metaDue: () => boolean;
  plan: (location: OverviewLocation) => OverviewPlan;
  /** True when the last refresh did not load every list `location` shows. */
  missed: (location: OverviewLocation) => boolean;
}

/**
 * Decides what one overview refresh reads. A refresh the user or an action asked
 * for reads the current page's lists, agents, version and health with new
 * requests. A timer refresh reads the current page's lists and leaves rarely
 * changing data to its slower pace.
 */
export function createOverviewCadence(
  readers: { fresh: Read; shared: Read },
  now: () => number = () => Date.now()
): OverviewCadence {
  let fromTimer = false;
  let metaAt: number | undefined;
  let agentsAt: number | undefined;
  let loaded: ReadonlySet<LabListKey> = new Set();

  const elapsed = (since: number | undefined, every: number) => since === undefined || now() - since >= every;

  return {
    markTimer: () => {
      fromTimer = true;
    },
    clearTimer: () => {
      fromTimer = false;
    },
    metaDue() {
      if (fromTimer && !elapsed(metaAt, META_REFRESH_MS)) return false;
      metaAt = now();
      return true;
    },
    plan(location) {
      const timer = fromTimer;
      fromTimer = false;
      const wanted = overviewListsFor(location);
      loaded = wanted;
      const read = timer ? readers.shared : readers.fresh;
      const agentsDue = !timer || showsAgents(location) || elapsed(agentsAt, AGENTS_REFRESH_MS);
      if (agentsDue) agentsAt = now();
      return {
        read,
        list: (key, load) => (wanted.has(key) ? fetchList(load) : Promise.resolve(SKIPPED_LIST)),
        agents: () => (agentsDue ? read('/api/agents') : Promise.resolve({}))
      };
    },
    missed(location) {
      for (const key of overviewListsFor(location)) if (!loaded.has(key)) return true;
      return false;
    }
  };
}

/** After a page change: refresh, and once more if a refresh already under way was planned for the old page. */
export async function refreshForPage(
  refresh: () => Promise<void>,
  cadence: Pick<OverviewCadence, 'missed'>,
  location: () => OverviewLocation
): Promise<void> {
  await refresh();
  if (cadence.missed(location())) await refresh();
}
