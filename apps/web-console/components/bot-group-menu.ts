import { pollApi } from '../lib/api.ts';
import { FUNCTIONAL_GROUPS_CHANGED_EVENT, type FunctionalGroup } from '../lib/functional-group-view.ts';

let cached: FunctionalGroup[] = [];
const listeners = new Set<() => void>();
let started = false;

export function getMenuGroups(): FunctionalGroup[] {
  return cached;
}

export function getMenuGroupsServer(): FunctionalGroup[] {
  return [];
}

export function subscribeMenuGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishMenuGroups(groups: FunctionalGroup[]) {
  cached = groups;
  for (const listener of listeners) listener();
}

function readGroups(detail: unknown) {
  if (!Array.isArray(detail)) return;
  publishMenuGroups(detail as FunctionalGroup[]);
}

export function ensureMenuGroups(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener(FUNCTIONAL_GROUPS_CHANGED_EVENT, (event) => {
    if (event instanceof CustomEvent) readGroups(event.detail);
  });
  void pollApi('/api/bot-functional-groups')
    .then((data) => readGroups((data as { groups?: FunctionalGroup[] }).groups))
    .catch(() => undefined);
}
