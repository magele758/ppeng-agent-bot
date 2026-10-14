import { existsSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { lookup } from 'node:dns/promises';
import { resolve as pathResolve, relative } from 'node:path';
import type { GoalVerifySpec } from './types.js';
import { isExecutableVerifySpec, isSafeRelPath } from './verify-spec.js';
import type { GoalSettings } from './settings.js';

export interface GoalVerifyContext {
  workspaceRoot?: string;
  settings?: GoalSettings;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoalVerifyResult {
  ok: boolean;
  reason: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata.google',
  'instance-data'
]);

export function isBlockedVerifyHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata' || host.endsWith('.internal')) return true;
  return isPrivateOrReservedIp(host);
}

/** WHATWG URLs rewrite IPv4-mapped hosts to hex, e.g. 127.0.0.1 → ::ffff:7f00:1. */
function ipv4FromMappedHex(tail: string): string | undefined {
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const hi = Number.parseInt(parts[0] ?? '', 16);
  const lo = Number.parseInt(parts[1] ?? '', 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return undefined;
  const value = ((hi << 16) | lo) >>> 0;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

export function isPrivateOrReservedIp(hostname: string): boolean {
  const stripped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIPv4(stripped)) {
    const parts = stripped.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (isIPv6(stripped)) {
    const h = stripped.toLowerCase();
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
    if (h.startsWith('::ffff:')) {
      const tail = h.slice('::ffff:'.length);
      const dotted = isIPv4(tail) ? tail : ipv4FromMappedHex(tail);
      if (!dotted) return false;
      return isPrivateOrReservedIp(dotted);
    }
  }
  return false;
}

export async function runGoalVerify(
  spec: GoalVerifySpec,
  ctx: GoalVerifyContext = {}
): Promise<GoalVerifyResult> {
  if (!isExecutableVerifySpec(spec)) {
    return { ok: false, reason: `verify spec 不可执行（kind=${spec.kind}）` };
  }
  switch (spec.kind) {
    case 'files_exist':
      return runFilesExist(spec, ctx);
    case 'http':
      if (ctx.settings && ctx.settings.allowHttpVerify === false) {
        return { ok: false, reason: 'http verify 已在 Lab 设置中关闭' };
      }
      return runHttp(spec, ctx);
    case 'command':
      return {
        ok: false,
        reason: 'command verify 默认不执行；仅当 Lab 显式开启且调用方传入 command 时才接受规格，运行时仍拒绝执行'
      };
    default: {
      const _never: never = spec.kind;
      void _never;
      return { ok: false, reason: '未知 verify kind' };
    }
  }
}

export function resolveUnderWorkspace(root: string, rel: string): string | undefined {
  if (!isSafeRelPath(rel)) return undefined;
  const resolved = pathResolve(root, rel);
  const relToRoot = relative(root, resolved);
  if (!relToRoot || relToRoot.startsWith('..') || relToRoot === '..') return undefined;
  return resolved;
}

function runFilesExist(spec: GoalVerifySpec, ctx: GoalVerifyContext): GoalVerifyResult {
  const root = ctx.workspaceRoot?.trim();
  if (!root) {
    return { ok: false, reason: 'files_exist verify 需要 workspaceRoot' };
  }
  const missing: string[] = [];
  for (const rel of spec.paths ?? []) {
    const resolved = resolveUnderWorkspace(root, rel);
    if (!resolved || !existsSync(resolved)) {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: `verify files_exist 失败，缺失：${missing.join('、')}` };
  }
  return { ok: true, reason: `verify files_exist 通过（${(spec.paths ?? []).length} 个路径）` };
}

async function runHttp(spec: GoalVerifySpec, ctx: GoalVerifyContext): Promise<GoalVerifyResult> {
  const raw = spec.url ?? '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'verify http URL 无效' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'verify http 仅允许 http(s)' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'verify http 拒绝带凭据的 URL' };
  }
  if (isBlockedVerifyHost(parsed.hostname)) {
    return { ok: false, reason: `verify http SSRF：拒绝主机 ${parsed.hostname}` };
  }
  try {
    const resolved = await lookup(parsed.hostname.replace(/^\[|\]$/g, ''), { all: true });
    for (const rec of resolved) {
      if (isPrivateOrReservedIp(rec.address)) {
        return { ok: false, reason: `verify http SSRF：解析到私网地址 ${rec.address}` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `verify http DNS 失败：${err instanceof Error ? err.message : String(err)}`
    };
  }

  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([timeoutSignal, ctx.signal]) : timeoutSignal;
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'error',
      signal
    });
    const expect = spec.expectStatus;
    const ok = typeof expect === 'number' ? res.status === expect : res.status >= 200 && res.status < 300;
    if (!ok) {
      return {
        ok: false,
        reason:
          `verify http 失败：GET ${parsed.origin}${parsed.pathname} → ${res.status}` +
          (typeof expect === 'number' ? `（期望 ${expect}）` : '')
      };
    }
    return { ok: true, reason: `verify http 通过：${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `verify http 执行异常：${msg}` };
  }
}
