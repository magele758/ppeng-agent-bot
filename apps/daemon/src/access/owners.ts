import { botDefinitionOwner, resolveBotPrincipal, sameBotPrincipal, sessionOwnerId, type RawAgentRuntime, type ResourceOwnerStore } from '@ppeng/agent-core';
import type { RouteContext } from '../routing.js';
import type { OwnerRef } from './types.js';

/** Registry kinds for resources whose rows carry no owner column. */
export const OWNER_KIND = {
  teamPlan: 'team-plan',
  swarmRun: 'swarm-run',
  researchTask: 'research-task',
  orchestrationRun: 'orchestration-run',
  cloudFolder: 'cloud-folder'
} as const;

const MISSING: OwnerRef = { found: false };

function owned(ownerId: string | undefined): OwnerRef {
  return { found: true, ownerId };
}

export interface OwnerLookups {
  runtime: RawAgentRuntime;
  owners: ResourceOwnerStore;
}

export function sessionRef({ runtime }: OwnerLookups, id: string | undefined): OwnerRef {
  const session = id ? runtime.getSession(id) : undefined;
  return session ? owned(sessionOwnerId(session)) : MISSING;
}

export function registryRef(
  { owners }: OwnerLookups,
  kind: string,
  id: string,
  exists: boolean
): OwnerRef {
  return exists ? owned(owners.ownerOf(kind, id)) : MISSING;
}

/** Bot definition access is independent of any private canonical session. */
export function botDefinitionRef(runtime: RawAgentRuntime, id: string | undefined): OwnerRef {
  const bot = id ? runtime.store.getBot(id) : undefined;
  if (!bot) return MISSING;
  const definitionOwner = botDefinitionOwner(runtime.store, bot.id);
  if (definitionOwner) {
    return sameBotPrincipal(definitionOwner, resolveBotPrincipal(runtime.store))
      ? {found: true, ownerId: undefined, unowned: 'allow'}
      : owned(definitionOwner.userId);
  }
  // Legacy rows with intact owner evidence can be inspected and migrated. Missing
  // evidence fails closed: a deleted private session never turns a definition public.
  const session = runtime.getSession(bot.canonicalSessionId);
  if (!session) return {found: true, ownerId: undefined, unowned: 'deny'};
  const ownerId = sessionOwnerId(session);
  const installation = resolveBotPrincipal(runtime.store);
  if (!ownerId || (ownerId === installation.userId && !session.metadata?.tenantId)) {
    return {found: true, ownerId: undefined, unowned: 'allow'};
  }
  return owned(ownerId);
}

export function botRef(lookups: OwnerLookups, id: string | undefined): OwnerRef {
  return botDefinitionRef(lookups.runtime, id);
}

export function cronJobRef(lookups: OwnerLookups, id: string): OwnerRef {
  const job = lookups.runtime.listCronJobs().find((j) => j.id === id);
  return job ? sessionRef(lookups, job.sessionId) : MISSING;
}

export function taskRef(lookups: OwnerLookups, id: string): OwnerRef {
  const task = lookups.runtime.getTask(id);
  if (!task) return MISSING;
  const metaUser = typeof task.metadata?.userId === 'string' ? task.metadata.userId.trim() : '';
  if (metaUser) return owned(metaUser);
  return task.sessionId ? sessionRef(lookups, task.sessionId) : owned(undefined);
}

export function memoryEntryRef(lookups: OwnerLookups, id: string): OwnerRef {
  const entry = lookups.runtime.store.agentMemory().getEntryById(id);
  if (!entry) return MISSING;
  if (entry.userId) return owned(entry.userId);
  return entry.sessionId ? sessionRef(lookups, entry.sessionId) : owned(undefined);
}

export function teamPlanRef(lookups: OwnerLookups, id: string): OwnerRef {
  const plan = lookups.runtime.store.teams().get(id);
  if (!plan) return MISSING;
  if (plan.sessionId) return sessionRef(lookups, plan.sessionId);
  return registryRef(lookups, OWNER_KIND.teamPlan, id, true);
}

export function swarmTaskRef(lookups: OwnerLookups, taskId: string): OwnerRef {
  const task = lookups.runtime.store.swarm().getTask(taskId);
  if (!task) return MISSING;
  return registryRef(lookups, OWNER_KIND.swarmRun, task.swarmRunId, true);
}

/** Optional string field of the (memoised) JSON body; non-objects read as empty. */
export async function bodyString(ctx: RouteContext, key: string): Promise<string | undefined> {
  const body = await ctx.readBody();
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Refs for optional body references; absent keys contribute nothing. */
export async function bodyRefs(
  ctx: RouteContext,
  refs: Array<[key: string, resolve: (id: string) => OwnerRef]>
): Promise<OwnerRef[]> {
  const out: OwnerRef[] = [];
  for (const [key, resolve] of refs) {
    const id = await bodyString(ctx, key);
    if (id) out.push(resolve(id));
  }
  return out;
}
