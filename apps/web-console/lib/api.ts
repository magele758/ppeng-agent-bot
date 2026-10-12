/** 浏览器侧：相对路径 `/api` 由 Next rewrites 代理到 daemon */

/**
 * Per-process ETag cache for GET requests. The daemon emits `ETag: W/"<n>"`
 * on poll-friendly list endpoints (sessions, tasks, approvals, social-post-
 * schedules, mailbox/all). When the server responds 304 we reuse the cached
 * payload instead of triggering a re-render.
 *
 * Cache is best-effort and process-local (cleared on full reload).
 */
const etagCache = new Map<string, { etag: string; data: unknown }>();

function isCacheableGet(path: string, init?: RequestInit): boolean {
  if (init?.method && init.method.toUpperCase() !== 'GET') return false;
  return path.startsWith('/api/');
}

/**
 * A 401 `login_required` replaces the Lab with the login screen.
 * `loginRequired: false` means login is not configured (draft release uses 403
 * `human_login_required` for that case). Neither one should lock the workspace.
 */
export function loginFailureLocksLab(
  status: number,
  body: { error?: unknown; loginRequired?: unknown } | null | undefined
): boolean {
  if (status !== 401 || body?.error !== 'login_required') return false;
  return body.loginRequired !== false;
}

/** AuthGate ignores a login-required event that explicitly says login is off. */
export function loginRequiredEventLocksLab(detail: { loginRequired?: boolean } | undefined): boolean {
  return detail?.loginRequired !== false;
}

export async function api(path: string, init?: RequestInit): Promise<unknown> {
  const cacheable = isCacheableGet(path, init);
  const cached = cacheable ? etagCache.get(path) : undefined;
  const headers = new Headers(init?.headers ?? {});
  if (cached) headers.set('if-none-match', cached.etag);

  const res = await fetch(path, { ...init, headers });

  // 304 → reuse cached body without parsing or re-rendering caller.
  if (res.status === 304 && cached) {
    return cached.data;
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    if (typeof window !== 'undefined' && loginFailureLocksLab(res.status, data)) {
      window.dispatchEvent(new CustomEvent('ppeng-login-required', { detail: { loginRequired: true } }));
    }
    throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  }

  if (cacheable) {
    const etag = res.headers.get('etag');
    if (etag) etagCache.set(path, { etag, data });
  }
  return data;
}
