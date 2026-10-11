/**
 * Access class of every daemon route, keyed by `METHOD pattern`.
 *
 * The Router refuses to register a route missing from this table, so a new
 * endpoint cannot ship without an authorization decision; the contract test
 * `scripts/test/route-access-contract.test.mjs` exercises every entry.
 * Classes are documented on {@link RouteAccess}.
 */
import type { RouteContext } from '../routing.js';
import {
  bodyRefs,
  bodyString,
  botRef,
  cronJobRef,
  memoryEntryRef,
  OWNER_KIND,
  registryRef,
  sessionRef,
  swarmTaskRef,
  taskRef,
  teamPlanRef,
  type OwnerLookups
} from './owners.js';
import type { OwnerRef, OwnerResource, RouteAccess, UnownedRule } from './types.js';

const PUBLIC: RouteAccess = { kind: 'public' };
const AUTHENTICATED: RouteAccess = { kind: 'authenticated' };
const ADMIN: RouteAccess = { kind: 'admin' };

function selfFiltered(resource: string): RouteAccess {
  return { kind: 'self-filtered', resource };
}

function owner(
  resource: OwnerResource,
  resolve: (ctx: RouteContext) => OwnerRef[] | Promise<OwnerRef[]>,
  unowned?: UnownedRule
): RouteAccess {
  return { kind: 'owner', resource, resolve, unowned };
}

function byParam(name: string, ref: (id: string) => OwnerRef) {
  return (ctx: RouteContext) => [ref(ctx.requireParam(name))];
}

function withRule(ref: OwnerRef, unowned: UnownedRule): OwnerRef {
  return ref.found ? { ...ref, unowned } : ref;
}

const SHARED_MEMORY_SCOPES = new Set(['team.memory', 'project.memory']);

function workspaceCloudFolderId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const binding = (body as Record<string, unknown>).workspaceBinding;
  if (!binding || typeof binding !== 'object') return undefined;
  const id = (binding as Record<string, unknown>).cloudFolderId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Signed-in callers may only name themselves as `userId`; shared scopes are admin writes. */
async function memoryWriteRefs(ctx: RouteContext, l: OwnerLookups): Promise<OwnerRef[]> {
  const refs = await bodyRefs(ctx, [
    ['sessionId', (id) => sessionRef(l, id)],
    ['userId', (id) => ({ found: true, ownerId: id })]
  ]);
  const scope = await bodyString(ctx, 'scope');
  if (scope && SHARED_MEMORY_SCOPES.has(scope)) refs.push({ found: true, ownerId: undefined, unowned: 'admin' });
  return refs;
}

export function buildRoutePolicy(l: OwnerLookups): Map<string, RouteAccess> {
  const session = owner('session', byParam('id', (id) => sessionRef(l, id)));
  const swarmRun = owner(
    'swarm-run',
    byParam('id', (id) => registryRef(l, OWNER_KIND.swarmRun, id, Boolean(l.runtime.store.swarm().getRun(id))))
  );
  const swarmTask = owner('swarm-task', byParam('taskId', (id) => swarmTaskRef(l, id)));
  const research = owner(
    'research-task',
    byParam('id', (id) =>
      registryRef(l, OWNER_KIND.researchTask, id, Boolean(l.runtime.store.research().getTask(id)))
    )
  );
  const orchestration = owner(
    'orchestration-run',
    byParam('id', (id) =>
      registryRef(l, OWNER_KIND.orchestrationRun, id, Boolean(l.runtime.store.orchestrator().getRun(id)))
    )
  );
  const teamPlan = owner('team-plan', byParam('id', (id) => teamPlanRef(l, id)));
  const cronJob = owner('cron-job', byParam('id', (id) => cronJobRef(l, id)), 'admin');
  const cloudFolderRef = (id: string) =>
    registryRef(l, OWNER_KIND.cloudFolder, id, Boolean(l.runtime.store.cloudFolders().get(id)));
  const cloudFolder = owner('cloud-folder', byParam('id', cloudFolderRef));
  const self = owner('user', byParam('id', (id) => ({ found: true, ownerId: id })));
  const sessionBodyRef = (key: string) => (ctx: RouteContext) =>
    bodyRefs(ctx, [[key, (id) => sessionRef(l, id)]]);
  const bindingRefs = async (ctx: RouteContext): Promise<OwnerRef[]> => {
    const folderId = workspaceCloudFolderId(await ctx.readBody());
    return folderId ? [cloudFolderRef(folderId)] : [];
  };
  const sessionCreateRefs = async (ctx: RouteContext): Promise<OwnerRef[]> => [
    ...(await bodyRefs(ctx, [['botId', (id) => withRule(botRef(l, id), 'allow')]])),
    ...(await bindingRefs(ctx))
  ];

  const entries: Array<[string, RouteAccess]> = [
    // auth + probes
    ['GET /api/version', PUBLIC],
    ['GET /api/health', PUBLIC],
    ['GET /api/readiness', PUBLIC],
    ['GET /api/auth/me', PUBLIC],
    ['POST /api/auth/logout', PUBLIC],
    ['GET /api/auth/google/start', PUBLIC],
    ['GET /api/auth/github/start', PUBLIC],
    ['GET /api/auth/google/callback', PUBLIC],
    ['GET /api/auth/github/callback', PUBLIC],

    // catalog / read-only runtime info
    ['GET /api/extensions', AUTHENTICATED],
    ['GET /api/tools', AUTHENTICATED],
    ['GET /api/agents', AUTHENTICATED],
    ['GET /api/skills', AUTHENTICATED],
    ['GET /api/optional-tool-groups', AUTHENTICATED],
    ['GET /api/doctor', ADMIN],
    ['GET /api/workspaces', ADMIN],
    ['GET /api/background-jobs', ADMIN],
    ['POST /api/scheduler/run', ADMIN],
    ['GET /api/daemon/restart-request', ADMIN],
    ['POST /api/daemon/restart-request/ack', ADMIN],
    ['GET /api/config/effective', ADMIN],

    // sessions
    ['GET /api/sessions', selfFiltered('session')],
    ['POST /api/sessions/bulk-delete', selfFiltered('session')],
    ['POST /api/sessions', owner('bot', sessionCreateRefs)],
    ['GET /api/sessions/team-overview', selfFiltered('session')],
    ['GET /api/sessions/:id/team', session],
    ['GET /api/sessions/:id/model-view', session],
    ['GET /api/sessions/:id/tool-results/:messageId', session],
    ['DELETE /api/sessions/:id', session],
    ['GET /api/sessions/:id', session],
    [
      'PATCH /api/sessions/:id',
      owner('session', async (ctx) => [sessionRef(l, ctx.requireParam('id')), ...(await bindingRefs(ctx))])
    ],
    ['GET /api/sessions/:id/permission', session],
    ['POST /api/sessions/:id/permission', session],
    ['POST /api/sessions/:id/messages', session],
    ['POST /api/sessions/:id/run', session],
    ['POST /api/sessions/:id/stream', session],
    ['POST /api/sessions/:id/cancel', session],
    ['POST /api/sessions/:id/fork', session],
    ['POST /api/sessions/:id/steer', session],
    ['PATCH /api/sessions/:id/steer/:itemId', session],
    ['DELETE /api/sessions/:id/steer/:itemId', session],
    ['POST /api/sessions/:id/a2ui/action', session],
    ['POST /api/sessions/:id/images/ingest-base64', session],
    ['POST /api/sessions/:id/images/fetch-url', session],
    ['POST /api/sessions/:id/attachments/ingest-base64', session],
    ['POST /api/sessions/:id/attachments/fetch-url', session],
    ['GET /api/sessions/:id/attachments', session],
    ['GET /api/sessions/:id/artifacts', session],
    ['GET /api/sessions/:id/dyn-tools', session],
    ['POST /api/sessions/:id/dyn-tools/:name/retire', session],
    ['POST /api/sessions/:id/dyn-tools/:name/promote', session],
    ['GET /api/sessions/:id/goal', session],
    ['POST /api/sessions/:id/ask-user/reply', session],
    ['GET /api/sessions/:id/trajectory', session],
    ['POST /api/chat', owner('session', sessionBodyRef('sessionId'))],
    ['POST /api/chat/stream', owner('session', sessionBodyRef('sessionId'))],
    [
      'GET /api/artifact/:id/download',
      owner(
        'artifact',
        byParam('id', (id) => {
          const row = l.runtime.getArtifactIndex(id);
          return row ? sessionRef(l, row.sessionId) : { found: false };
        })
      )
    ],
    [
      'GET /api/traces',
      owner('session', (ctx) => [sessionRef(l, ctx.url.searchParams.get('sessionId') ?? undefined)])
    ],

    // approvals / tasks / goals / teams
    ['GET /api/approvals', selfFiltered('approval')],
    [
      'POST /api/approvals/:id/:decision',
      owner(
        'approval',
        byParam('id', (id) => {
          const pending = l.runtime.listApprovals().find((a) => a.id === id);
          return pending ? sessionRef(l, pending.sessionId) : { found: false };
        })
      )
    ],
    ['GET /api/tasks', selfFiltered('task')],
    ['POST /api/tasks', selfFiltered('task')],
    ['GET /api/tasks/:id', owner('task', byParam('id', (id) => taskRef(l, id)))],
    ['GET /api/goals/settings', AUTHENTICATED],
    ['PATCH /api/goals/settings', ADMIN],
    ['GET /api/goals', selfFiltered('goal')],
    ['POST /api/goals', owner('session', sessionBodyRef('sessionId'))],
    [
      'GET /api/goals/:id',
      owner(
        'goal',
        byParam('id', (id) => {
          const goal = l.runtime.store.goal().get(id);
          return goal ? sessionRef(l, goal.sessionId) : { found: false };
        })
      )
    ],
    ['POST /api/teams', owner('session', sessionBodyRef('parentSessionId'))],
    ['GET /api/teams/dag/settings', AUTHENTICATED],
    ['PATCH /api/teams/dag/settings', ADMIN],
    ['GET /api/teams/plans', selfFiltered('team-plan')],
    ['POST /api/teams/plans', owner('session', sessionBodyRef('sessionId'))],
    ['GET /api/teams/plans/:id', teamPlan],
    ['POST /api/teams/plans/:id/start', teamPlan],
    ['POST /api/teams/plans/:id/resume', teamPlan],
    ['POST /api/teams/plans/:id/gates/:gate/decide', teamPlan],

    // bots + cron
    ['GET /api/bots', selfFiltered('bot')],
    ['POST /api/bots', selfFiltered('bot')],
    ['GET /api/bots/:id', owner('bot', byParam('id', (id) => botRef(l, id)), 'allow')],
    ['PATCH /api/bots/:id', owner('bot', byParam('id', (id) => botRef(l, id)), 'admin')],
    ['POST /api/bots/:id/open', owner('bot', byParam('id', (id) => botRef(l, id)), 'allow')],
    ['GET /api/cron/jobs', selfFiltered('cron-job')],
    [
      'POST /api/cron/jobs',
      owner(
        'cron-job',
        (ctx) =>
          bodyRefs(ctx, [
            ['sessionId', (id) => sessionRef(l, id)],
            ['botId', (id) => botRef(l, id)]
          ]),
        'admin'
      )
    ],
    ['GET /api/cron/jobs/:id', cronJob],
    ['PATCH /api/cron/jobs/:id', cronJob],
    ['DELETE /api/cron/jobs/:id', cronJob],

    // memory / users / tenants
    ['GET /api/memory/settings', AUTHENTICATED],
    ['PATCH /api/memory/settings', ADMIN],
    ['GET /api/memory/observations', selfFiltered('memory-entry')],
    ['POST /api/memory/preview', selfFiltered('memory-entry')],
    ['POST /api/memory/dream-now', selfFiltered('memory-entry')],
    ['GET /api/users/:id/profile', self],
    ['PATCH /api/users/:id/profile', self],
    ['GET /api/memory', selfFiltered('memory-entry')],
    ['POST /api/memory', owner('memory-entry', (ctx) => memoryWriteRefs(ctx, l))],
    ['DELETE /api/memory/:id', owner('memory-entry', byParam('id', (id) => memoryEntryRef(l, id)), 'admin')],
    ['POST /api/memory/expire', ADMIN],
    ['GET /api/users', selfFiltered('user')],
    ['POST /api/users', ADMIN],
    ['GET /api/users/:id', self],
    ['GET /api/tenants', AUTHENTICATED],
    ['POST /api/tenants', ADMIN],
    ['PUT /api/tenants/:id/members/:userId', ADMIN],

    // swarm / research / orchestration
    ['GET /api/swarm/runs', selfFiltered('swarm-run')],
    [
      'POST /api/swarm/runs',
      owner('orchestration-run', (ctx) =>
        bodyRefs(ctx, [
          [
            'orchestrationRunId',
            (id) =>
              registryRef(l, OWNER_KIND.orchestrationRun, id, Boolean(l.runtime.store.orchestrator().getRun(id)))
          ]
        ])
      )
    ],
    ['GET /api/swarm/runs/:id', swarmRun],
    ['POST /api/swarm/runs/:id/start', swarmRun],
    ['PATCH /api/swarm/runs/:id/status', swarmRun],
    ['GET /api/swarm/runs/:id/tasks', swarmRun],
    ['POST /api/swarm/runs/:id/tasks', swarmRun],
    ['PATCH /api/swarm/tasks/:taskId/status', swarmTask],
    ['POST /api/swarm/tasks/:taskId/claim', swarmTask],
    ['GET /api/swarm/runs/:id/reviews', swarmRun],
    ['POST /api/swarm/runs/:id/reviews', swarmRun],
    ['GET /api/research/tasks', selfFiltered('research-task')],
    ['POST /api/research/tasks', selfFiltered('research-task')],
    ['GET /api/research/tasks/:id', research],
    ['PATCH /api/research/tasks/:id/status', research],
    ['POST /api/research/tasks/:id/run', research],
    ['GET /api/research/tasks/:id/sources', research],
    ['POST /api/research/tasks/:id/sources', research],
    ['GET /api/research/tasks/:id/evidence', research],
    ['POST /api/research/tasks/:id/evidence', research],
    ['GET /api/research/tasks/:id/claims', research],
    ['POST /api/research/tasks/:id/claims', research],
    ['GET /api/orchestration/runs', selfFiltered('orchestration-run')],
    ['POST /api/orchestration/runs', selfFiltered('orchestration-run')],
    ['GET /api/orchestration/runs/:id', orchestration],
    ['PATCH /api/orchestration/runs/:id/status', orchestration],
    ['GET /api/orchestration/runs/:id/steps', orchestration],
    ['POST /api/orchestration/runs/:id/steps', orchestration],
    ['GET /api/orchestration/runs/:id/events', orchestration],
    ['POST /api/orchestration/runs/:id/events', orchestration],

    // workspaces: projects are admin-managed host paths; cloud folders are per user
    ['GET /api/projects', AUTHENTICATED],
    ['POST /api/projects', ADMIN],
    ['GET /api/projects/:id', AUTHENTICATED],
    ['PATCH /api/projects/:id', ADMIN],
    ['DELETE /api/projects/:id', ADMIN],
    ['POST /api/projects/:id/roots', ADMIN],
    ['DELETE /api/projects/:id/roots/:rootId', ADMIN],
    ['POST /api/fs/validate', ADMIN],
    ['GET /api/fs/browse', ADMIN],
    ['GET /api/cloud-folders', selfFiltered('cloud-folder')],
    ['POST /api/cloud-folders', selfFiltered('cloud-folder')],
    ['GET /api/cloud-folders/:id', cloudFolder],
    ['DELETE /api/cloud-folders/:id', cloudFolder],

    // global agent-to-agent plumbing
    ['GET /api/mailbox', ADMIN],
    ['GET /api/mailbox/all', ADMIN],
    ['POST /api/mailbox', ADMIN],
    ['GET /api/social-post-schedules', ADMIN],
    ['POST /api/social-post-schedules/:taskId/action', ADMIN],

    // global settings: everyone reads the public view, admins write
    ['GET /api/ingestion/settings', AUTHENTICATED],
    ['PATCH /api/ingestion/settings', ADMIN],
    ['GET /api/browser/settings', AUTHENTICATED],
    ['PATCH /api/browser/settings', ADMIN],
    ['GET /api/web/settings', AUTHENTICATED],
    ['PATCH /api/web/settings', ADMIN],
    ['GET /api/capabilities/settings', AUTHENTICATED],
    ['PATCH /api/capabilities/settings', ADMIN],
    ['GET /api/capabilities/cbom', AUTHENTICATED],
    ['GET /api/capabilities', AUTHENTICATED],
    ['POST /api/capabilities', ADMIN],
    ['GET /api/capabilities/:id', AUTHENTICATED],
    ['PATCH /api/capabilities/:id', ADMIN],
    ['POST /api/capabilities/:id/bind', ADMIN],
    ['POST /api/capabilities/:id/verify', ADMIN],
    ['POST /api/capabilities/probe/tailscale', ADMIN],
    ['GET /api/compact/settings', AUTHENTICATED],
    ['PATCH /api/compact/settings', ADMIN],
    ['GET /api/gateway/settings', ADMIN],
    ['PATCH /api/gateway/settings', ADMIN],
    ['GET /api/dyn-tools/settings', AUTHENTICATED],
    ['PATCH /api/dyn-tools/settings', ADMIN],
    ['GET /api/jev/settings', AUTHENTICATED],
    ['PATCH /api/jev/settings', ADMIN],
    ['POST /api/jev/probe', ADMIN],
    ['GET /api/langfuse/settings', AUTHENTICATED],
    ['PATCH /api/langfuse/settings', ADMIN],
    ['POST /api/langfuse/probe', ADMIN],
    ['GET /api/loop/settings', AUTHENTICATED],
    ['PATCH /api/loop/settings', ADMIN],
    ['GET /api/model-fallback/settings', AUTHENTICATED],
    ['PATCH /api/model-fallback/settings', ADMIN],
    ['GET /api/model-providers', AUTHENTICATED],
    ['POST /api/model-providers', ADMIN],
    ['POST /api/model-providers/preview-scan', ADMIN],
    ['PATCH /api/model-providers/routing', ADMIN],
    ['PATCH /api/model-providers/default', ADMIN],
    ['PATCH /api/model-providers/:id', ADMIN],
    ['DELETE /api/model-providers/:id', ADMIN],
    ['POST /api/model-providers/:id/scan', ADMIN],
    ['GET /api/sandbox/settings', AUTHENTICATED],
    ['PATCH /api/sandbox/settings', ADMIN],
    ['GET /api/secrets', ADMIN],
    ['PUT /api/secrets/:name', ADMIN],
    ['DELETE /api/secrets/:name', ADMIN],
    ['GET /api/skills/settings', AUTHENTICATED],
    ['PATCH /api/skills/settings', ADMIN],
    ['GET /api/skill-proposals/settings', AUTHENTICATED],
    ['PATCH /api/skill-proposals/settings', ADMIN],
    ['GET /api/skill-proposals', ADMIN],
    ['GET /api/skill-proposals/:id', ADMIN],
    ['POST /api/skill-proposals/:id/approve', ADMIN],
    ['POST /api/skill-proposals/:id/reject', ADMIN],
    ['POST /api/skill-proposals/:id/revoke', ADMIN],
    ['POST /api/eval/skills/run', ADMIN],
    ['POST /api/eval/skills/compare', ADMIN],
    ['GET /api/eval/skills/synthetic-cases', ADMIN],
    ['GET /api/event-log/settings', AUTHENTICATED],
    ['PATCH /api/event-log/settings', ADMIN],

    // self-heal drives git / npm on the host
    ['POST /api/self-heal/start', ADMIN],
    ['GET /api/self-heal/status', ADMIN],
    ['GET /api/self-heal/runs', ADMIN],
    ['GET /api/self-heal/runs/:runId', ADMIN],
    ['GET /api/self-heal/runs/:runId/events', ADMIN],
    ['POST /api/self-heal/runs/:runId/stop', ADMIN],
    ['POST /api/self-heal/runs/:runId/resume', ADMIN],

    // evolution dashboard (read-only repo docs)
    ['GET /api/evolution/overview', AUTHENTICATED],
    ['GET /api/evolution/results', AUTHENTICATED],
    ['GET /api/evolution/result', AUTHENTICATED],
    ['GET /api/evolution/reports', AUTHENTICATED],
    ['GET /api/evolution/report/:id', AUTHENTICATED],
    ['POST /api/evolution/start', ADMIN]
  ];

  const table = new Map<string, RouteAccess>();
  for (const [key, access] of entries) {
    if (table.has(key)) throw new Error(`Duplicate route policy: ${key}`);
    table.set(key, access);
  }
  return table;
}
