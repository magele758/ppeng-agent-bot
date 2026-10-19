import { AuthorizationError, NotFoundError } from '../errors.js';
import { ResourceOwnerStore } from '../auth/resource-owners.js';
import type { RequestAuth } from '../auth/types.js';
import { principalFromSession, resolveBotPrincipal, sameBotPrincipal } from '../bots/bot-identity.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';

function caller(store: SqliteStateStore, session: SessionRecord): RequestAuth {
  const principal = principalFromSession(store, session);
  const local = sameBotPrincipal(principal, resolveBotPrincipal(store));
  const admin = local || store.agentMemory().getMemberships(principal.userId)
    .some(m => m.tenantId === principal.tenantId && ['owner', 'admin'].includes(m.role));
  return { isolate: true, labProxy: false, admin, user: {id: principal.userId, tenantId: principal.tenantId ?? ''} };
}

const RESOURCES = [
  {prefix: 'lab_team_plan_', kind: 'team-plan', idKey: 'planId', singular: 'plan', plural: 'plans'},
  {prefix: 'lab_swarm_run_', kind: 'swarm-run', idKey: 'runId', singular: 'run', plural: 'runs'},
  {prefix: 'lab_research_task_', kind: 'research-task', idKey: 'taskId', singular: 'task', plural: 'tasks'},
  {prefix: 'lab_orchestration_run_', kind: 'orchestration-run', idKey: 'runId', singular: 'run', plural: 'runs'}
];

function visible(store: SqliteStateStore, owners: ResourceOwnerStore, kind: string, id: string, auth: RequestAuth): boolean {
  const plan = kind === 'team-plan' ? store.teams().get(id) : undefined;
  if (plan?.sessionId) {
    const session = store.getSession(plan.sessionId);
    if (!session) return false;
    const principal = principalFromSession(store, session);
    return principal.userId === auth.user?.id && (principal.tenantId ?? '') === auth.user?.tenantId;
  }
  const owner = owners.ownerOf(kind, id);
  return owner === undefined ? auth.admin === true : owner === auth.user?.id;
}

/** Apply the same administrator/owner boundaries as the Lab HTTP entry points. */
export async function withProductAccess(
  store: SqliteStateStore, session: SessionRecord, name: string, write: boolean,
  args: Record<string, unknown>, run: () => Promise<unknown>
): Promise<unknown> {
  const auth = caller(store, session);
  const global = write && (name.startsWith('lab_project_') ||
    name.startsWith('lab_settings_') || name.startsWith('lab_model_'));
  if (global && !auth.admin) throw new AuthorizationError('admin_required');
  const resource = RESOURCES.find(item => name.startsWith(item.prefix));
  if (!resource) return run();
  const owners = new ResourceOwnerStore(store.db);
  const rawId = args[resource.idKey];
  const id = typeof rawId === 'string' ? rawId.trim() : undefined;
  if (typeof id === 'string' && !visible(store, owners, resource.kind, id, auth)) {
    throw new NotFoundError(resource.kind, id);
  }
  const result = await run() as Record<string, unknown>;
  if (name.endsWith('_list')) {
    const rows = result[resource.plural] as Array<{id: string}>;
    return {...result, [resource.plural]: rows.filter(row => visible(store, owners, resource.kind, row.id, auth))};
  }
  if (name.endsWith('_create')) {
    const row = result[resource.singular] as {id: string};
    owners.claim(resource.kind, row.id, auth);
  }
  return result;
}
