import type { RouteContext } from '../routing.js';

/**
 * Resource kinds whose ownership the router resolves before a handler runs.
 * Every kind must have a fixture in `scripts/test/route-access-contract.test.mjs`.
 */
export type OwnerResource =
  | 'session'
  | 'artifact'
  | 'approval'
  | 'task'
  | 'goal'
  | 'bot'
  | 'cron-job'
  | 'memory-entry'
  | 'user'
  | 'team-plan'
  | 'swarm-run'
  | 'swarm-task'
  | 'research-task'
  | 'orchestration-run'
  | 'cloud-folder';

export type UnownedRule = 'deny' | 'allow' | 'admin';

/**
 * `found: false` lets the handler answer with its usual 404 / 400.
 * `unowned` overrides the route rule for this one reference.
 */
export type OwnerRef =
  | { found: false }
  | { found: true; ownerId: string | undefined; unowned?: UnownedRule };

/**
 * Who may reach a route once Lab login isolates users (`auth.isolate`).
 * Single-user / operator requests (`isolate === false`) pass Lab access classes;
 * external-agent credentials remain mandatory.
 *
 * - `public`: no login (health probes, OAuth handshake).
 * - `authenticated`: any signed-in user; the payload is not per-user data.
 * - `self-filtered`: any signed-in user; the handler scopes reads/writes to the
 *   caller (list filtering, forced `userId`). `resource` names what is filtered.
 * - `owner`: the router resolves the owner of every resource the request names
 *   (path params and body references) and answers 404 unless the caller owns it.
 *   `unowned` decides resources without an owner: `deny` (default), `allow`
 *   (shared, e.g. operator-made bots), or `admin`.
 * - `admin`: tenant owner/admin users and operators only (global settings,
 *   secrets, host filesystem, daemon control).
 * - `external-agent`: requires its own scoped credential on every request,
 *   including when Lab login is off. Task ownership is filtered by its handler.
 */
export type RouteAccess =
  | { kind: 'public' }
  /** Always checked, even in single-user mode; independent of daemon/Lab credentials. */
  | { kind: 'external-agent'; authenticate: (ctx: RouteContext) => void }
  | { kind: 'authenticated' }
  | { kind: 'self-filtered'; resource: string }
  | {
      kind: 'owner';
      resource: OwnerResource;
      resolve: (ctx: RouteContext) => OwnerRef[] | Promise<OwnerRef[]>;
      unowned?: UnownedRule;
    }
  | { kind: 'admin' };

export type RouteAccessKind = RouteAccess['kind'];
