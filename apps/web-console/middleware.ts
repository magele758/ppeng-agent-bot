import type { NextRequest } from 'next/server.js';
import { NextResponse } from 'next/server.js';
import {
  copyProxyResponseHeaders,
  daemonProxyErrorMessage,
  LAB_PROXY_HEADER,
  sanitizeProxyHeaders,
  stripHumanReleaseHeader
} from './lib/daemon-proxy.ts';

function daemonBase(): string {
  return (process.env.DAEMON_PROXY_TARGET ?? 'http://127.0.0.1:37070').replace(/\/$/, '');
}

/** Mirrors daemon `RAW_AGENT_AUTH_TOKEN`; inject so browser clients never expose the secret. */
function appendDaemonBearerIfConfigured(headers: Headers): void {
  const token = String(process.env.RAW_AGENT_AUTH_TOKEN ?? '').trim();
  if (!token) return;
  const existing = headers.get('authorization');
  if (existing?.trim()) return;
  headers.set('authorization', `Bearer ${token}`);
}

function appendLabForwarding(request: NextRequest, headers: Headers): void {
  headers.set(LAB_PROXY_HEADER, '1');
  // fetch() to the daemon replaces Host. Forward the browser host so a loopback
  // Lab keeps its own port as the OAuth callback. The daemon accepts this only
  // when it is loopback; a public host is rejected unless public origin is set.
  headers.set('x-forwarded-host', request.nextUrl.host);
  headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(/:$/, '') || 'http');
}

export const config = {
  matcher: '/api/:path*'
};

/** 构建时 next.config rewrites 会固化目标；e2e 随机 daemon 端口必须在运行时解析 DAEMON_PROXY_TARGET */
export async function middleware(request: NextRequest) {
  const targetUrl = `${daemonBase()}${request.nextUrl.pathname}${request.nextUrl.search}`;
  const headers = sanitizeProxyHeaders(request.headers);
  appendDaemonBearerIfConfigured(headers);
  stripHumanReleaseHeader(headers);
  appendLabForwarding(request, headers);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Buffer the body instead of streaming request.body: undici fetch turns any
    // 401 reply to a stream-bodied request into a network error ("expected
    // non-null body source"), which would mask the daemon's login_required
    // response as a 502. Hop-by-hop headers (especially content-length) are
    // already stripped by sanitizeProxyHeaders.
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  try {
    const res = await fetch(targetUrl, init);
    const outHeaders = copyProxyResponseHeaders(res.headers);
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders
    });
  } catch (err) {
    return NextResponse.json(
      { error: `daemon proxy failed: ${daemonProxyErrorMessage(err)}` },
      { status: 502 }
    );
  }
}
