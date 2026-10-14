import { access, constants, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ValidationError,
  buildOptionalToolGroupsPayload,
  canAccessSession,
  loadOptionalToolGroupsFromEnv,
  optionalToolGroupsFeatureEnabled,
  stampOwnerMetadata,
  type ApprovalRecord,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { etagFromState, json, sendIfNotModified } from '../http-utils.js';
import { guardSession } from '../session-guard.js';

const APPROVAL_STATUSES: ReadonlyArray<ApprovalRecord['status']> = ['pending', 'approved', 'rejected'];

/** Resume when an approval is granted, or when a rejection settles the wave. */
export function shouldResumeAfterApproval(
  approvalStatus: ApprovalRecord['status'],
  sessionStatus: string | undefined,
  pendingLeft: boolean
): boolean {
  if (sessionStatus !== 'idle') return false;
  if (approvalStatus === 'approved') return true;
  return approvalStatus === 'rejected' && !pendingLeft;
}

interface MiscOptions {
  pkgName: string;
  pkgVersion: string;
}

export function miscRoutes(runtime: RawAgentRuntime, opts: MiscOptions): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/version',
      handler: ({ response }) => json(response, 200, { name: opts.pkgName, version: opts.pkgVersion })
    },
    {
      method: 'GET',
      pattern: '/api/health',
      handler: ({ response }) =>
        json(response, 200, { ok: true, adapter: runtime.modelAdapter.name, version: opts.pkgVersion })
    },
    {
      method: 'GET',
      pattern: '/api/readiness',
      handler: async ({ response }) => {
        const checks: Record<string, boolean> = {};
        const reasons: string[] = [];
        let schemaVersion: number | undefined;

        // Check stateDir is writable
        const probeFile = join(runtime.stateDir, `.ppeng-readiness-${randomUUID()}.tmp`);
        try {
          await writeFile(probeFile, '1');
          await unlink(probeFile);
          checks['stateDirWritable'] = true;
        } catch {
          checks['stateDirWritable'] = false;
          reasons.push('stateDir not writable');
        }

        // Check SQLite db file is accessible (readable after runtime init)
        const dbPath = join(runtime.stateDir, 'runtime.sqlite');
        try {
          await access(dbPath, constants.R_OK | constants.W_OK);
          const row = runtime.store.db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version?: number } | undefined;
          if (!Number.isInteger(row?.version)) throw new Error('schema version unavailable');
          schemaVersion = row!.version;
          checks['sqliteReadWrite'] = true;
        } catch {
          // Runtime initialization creates the DB before the HTTP server starts.
          checks['sqliteReadWrite'] = false;
          reasons.push('sqlite database is not readable/writable');
        }

        const ready = Object.values(checks).every(Boolean);
        if (ready) {
          json(response, 200, { ready: true, checks, schemaVersion });
        } else {
          json(response, 400, { ready: false, reason: reasons.join('; '), checks });
        }
      }
    },
    {
      method: 'GET',
      pattern: '/api/doctor',
      handler: async ({ response }) => {
        // Always 200 — severity lives in report.ok / checks[].severity (CLI exits 1 on !ok)
        json(response, 200, await runtime.runDoctorCheckAsync());
      }
    },
    {
      method: 'GET',
      pattern: '/api/extensions',
      handler: ({ response }) => {
        json(response, 200, { extensions: runtime.listExtensions() });
      }
    },
    {
      method: 'GET',
      pattern: '/api/tools',
      handler: ({ response }) => {
        json(response, 200, {
          tools: runtime.tools.map((tool) => ({ name: tool.name }))
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/agents',
      handler: ({ response }) => {
        // Lazily upsert built-in agents so newly-added builtins surface without a daemon restart.
        runtime.ensureBuiltinAgentsSynced();
        json(response, 200, { agents: runtime.listAgents() });
      }
    },
    {
      method: 'GET',
      pattern: '/api/skills',
      handler: async ({ response }) => {
        const skills = await runtime.listSkills();
        json(response, 200, {
          skills: skills.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            source: s.source ?? 'workspace',
            skillPath: s.skillPath,
            aliases: s.aliases ?? [],
            triggerWords: s.triggerWords ?? []
          }))
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/optional-tool-groups',
      handler: ({ response }) => {
        const enabled = optionalToolGroupsFeatureEnabled(process.env);
        const groups = loadOptionalToolGroupsFromEnv(process.env);
        json(response, 200, {
          enabled,
          catalog: buildOptionalToolGroupsPayload(groups)
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/workspaces',
      handler: ({ response }) => json(response, 200, { workspaces: runtime.listWorkspaces() })
    },
    {
      method: 'GET',
      pattern: '/api/background-jobs',
      handler: ({ response }) => json(response, 200, { jobs: runtime.listBackgroundJobs() })
    },
    {
      method: 'GET',
      pattern: '/api/approvals',
      handler: ({ request, response, auth, url }) => {
        if (sendIfNotModified(request, response, etagFromState(runtime.getStateVersion()))) return;
        const status = url.searchParams.get('status');
        if (status !== null && !APPROVAL_STATUSES.includes(status as ApprovalRecord['status'])) {
          throw new ValidationError(`Invalid status: ${status}`);
        }
        const approvals = runtime.listApprovals(status ? (status as ApprovalRecord['status']) : undefined).filter((item) => {
          if (!auth.isolate) return true;
          const session = runtime.getSession(item.sessionId);
          return Boolean(session && canAccessSession(session, auth));
        });
        json(response, 200, { approvals });
      }
    },
    {
      method: 'POST',
      pattern: '/api/approvals/:id/:decision',
      handler: async ({ requireParam, response, auth }) => {
        const id = requireParam('id');
        const decision = requireParam('decision') === 'reject' ? 'rejected' : 'approved';
        const pending = runtime.listApprovals().find((item) => item.id === id);
        if (pending) guardSession(runtime, pending.sessionId, auth);
        const approval = await runtime.approve(id, decision);
        const session = runtime.getSession(approval.sessionId);
        const pendingLeft = runtime
          .listApprovals('pending')
          .some((item) => item.sessionId === approval.sessionId);
        if (session && shouldResumeAfterApproval(approval.status, session.status, pendingLeft)) {
          await runtime.runSession(session.id);
        }
        json(response, 200, {
          approval,
          session: session ? runtime.getSession(session.id) : undefined,
          latestAssistant: session ? runtime.getLatestAssistantText(session.id) : undefined
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/traces',
      handler: async ({ url, response, auth }) => {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) throw new ValidationError('Missing sessionId');
        guardSession(runtime, sessionId, auth);
        const limit = Number(url.searchParams.get('limit') ?? '500');
        const events = await runtime.listTraceEvents(sessionId, Number.isFinite(limit) ? limit : 500);
        json(response, 200, { sessionId, events });
      }
    },
    {
      method: 'POST',
      pattern: '/api/scheduler/run',
      handler: async ({ response }) => {
        await runtime.runScheduler();
        json(response, 200, { ok: true });
      }
    },
    {
      method: 'POST',
      pattern: '/api/teams',
      handler: async ({ readBody, response, auth }) => {
        const body = (await readBody()) as Record<string, unknown>;
        const name = String(body.name ?? '').trim();
        const role = String(body.role ?? '').trim();
        const prompt = String(body.prompt ?? '').trim();
        if (!name || !role || !prompt) throw new ValidationError('Missing name, role, or prompt');
        if (typeof body.parentSessionId === 'string') {
          guardSession(runtime, body.parentSessionId, auth);
        }
        const session = runtime.createTeammateSession({
          name,
          role,
          prompt,
          taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
          parentSessionId: typeof body.parentSessionId === 'string' ? body.parentSessionId : undefined,
          background: body.background !== false,
          metadata: stampOwnerMetadata({}, auth)
        });
        if (body.autoRun !== false) await runtime.runSession(session.id);
        json(response, 201, {
          session: runtime.getSession(session.id),
          latestAssistant: runtime.getLatestAssistantText(session.id)
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/daemon/restart-request',
      handler: ({ response }) =>
        json(response, 200, { restartRequest: runtime.getDaemonRestartRequest() ?? null })
    },
    {
      method: 'POST',
      pattern: '/api/daemon/restart-request/ack',
      handler: ({ response }) => {
        runtime.acknowledgeDaemonRestart();
        json(response, 200, { ok: true });
      }
    }
  ];
}
