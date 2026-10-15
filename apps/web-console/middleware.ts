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

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Edge/undici requires duplex when forwarding a body; hop-by-hop headers
    // (especially content-length) on the copied request make POST fetch fail.
    init.body = request.body;
    init.duplex = 'half';
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
