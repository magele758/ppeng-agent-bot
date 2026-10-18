import { AppError, AuthorizationError, NotFoundError, type RequestAuth } from '@ppeng/agent-core';
import type { RouteContext } from '../routing.js';
import type { OwnerRef, RouteAccess } from './types.js';

/** Message matches the Lab `login_required` event in `apps/web-console/lib/api.ts`. */
export class UnauthenticatedError extends AppError {
  constructor() {
    super('UNAUTHENTICATED', 'login_required', 401);
  }
}

type OwnerAccess = Extract<RouteAccess, { kind: 'owner' }>;

function requireAdmin(auth: RequestAuth): void {
  if (!auth.admin) throw new AuthorizationError('admin_required');
}

function checkOwnerRef(ref: OwnerRef, access: OwnerAccess, auth: RequestAuth): void {
  if (!ref.found) return;
  if (ref.ownerId === undefined) {
    const unowned = ref.unowned ?? access.unowned ?? 'deny';
    if (unowned === 'allow') return;
    if (unowned === 'admin') return requireAdmin(auth);
    if (auth.admin) return;
    throw new NotFoundError(access.resource);
  }
  if (ref.ownerId !== auth.user?.id) throw new NotFoundError(access.resource);
}

/**
 * Router-level gate run before every handler. Throws 401 / 403 / 404 errors that
 * server.ts maps to HTTP statuses; resolves silently when the request may proceed.
 */
export async function enforceRouteAccess(access: RouteAccess, ctx: RouteContext): Promise<void> {
  if (access.kind === 'external-agent') {
    access.authenticate(ctx);
    return;
  }
  const { auth } = ctx;
  if (access.kind === 'public' || !auth.isolate) return;
  if (!auth.user) throw new UnauthenticatedError();
  switch (access.kind) {
    case 'authenticated':
    case 'self-filtered':
      return;
    case 'admin':
      return requireAdmin(auth);
    case 'owner': {
      for (const ref of await access.resolve(ctx)) checkOwnerRef(ref, access, auth);
      return;
    }
    default: {
      const never: never = access;
      throw new Error(`Unhandled route access ${JSON.stringify(never)}`);
    }
  }
}
