/**
 * Per-command isolation chosen by the dialogue model.
 * Humans do not pick a mode before a shell tool can use one.
 * Container is not a choice: it is not implemented and must not run as direct.
 */

import { sortKeys } from '../runtime/helpers.js';
import type { SandboxMode } from './sandbox-settings.js';
import { LinuxBwrapProvider, MacOSSandboxProvider } from './os-sandbox.js';
import { CloudflareComputerProvider } from './cloudflare-computer-provider.js';

export const MODEL_ISOLATION_VALUES = ['os', 'direct', 'remote'] as const;

export const MODEL_ISOLATION_DESCRIPTION = [
  'Isolation for this single command. Omit it and the runtime uses the strongest isolation this machine can apply.',
  'os — stronger local isolation: macOS seatbelt or Linux bubblewrap blocks ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, and ~/.docker. Use this, or omit the field, for ordinary workspace commands.',
  'direct — weaker: no OS sandbox, only environment scrubbing, so the command can read those secret folders. Use it only when the user needs something the OS sandbox blocks. It does not run until a person approves it, unless this chat is already set to never ask for approval.',
  'remote — stronger than the local sandbox when a remote computer is already connected: the command runs there instead of on this machine. If none is connected, the command does not run and is not moved onto this machine.',
  'Container isolation is not offered.'
].join(' ');

export const DIRECT_ISOLATION_REFUSAL =
  'Command was not run. Choosing direct drops the OS sandbox (environment scrubbing still applies) and needs human approval first. It will not run until that approval is granted.';

export const CONTAINER_ISOLATION_REFUSAL =
  'Command was not run. Container isolation is not available, so this did not fall back to running without an OS sandbox.';

export const OS_UNAVAILABLE_REFUSAL =
  'Command was not run. OS isolation is not available on this machine, so this did not fall back to running without an OS sandbox.';

export const REMOTE_UNAVAILABLE_REFUSAL =
  'Command was not run. Remote isolation is not connected, so this did not fall back to running on this machine.';

export const DIRECT_NOT_ON_RUNNER_REFUSAL =
  'Command was not run. Dropping OS isolation only applies to commands on this machine. This runner stays off-machine, and the command was not pulled back locally.';

export const UNKNOWN_ISOLATION_REFUSAL =
  'Command was not run. Unknown isolation. Choose os, direct, or remote, or omit the field for the strongest available. This did not fall back to running without an OS sandbox.';

export function isolationInputSchema(): {
  type: 'string';
  enum: string[];
  description: string;
} {
  return {
    type: 'string',
    enum: [...MODEL_ISOLATION_VALUES],
    description: MODEL_ISOLATION_DESCRIPTION
  };
}

export type ShellSandboxKind = 'native' | 'remote_vm' | 'microservice';

export interface ShellIsolationAvailability {
  kind: ShellSandboxKind;
  os: boolean;
  remote: boolean;
}

export type ShellIsolationDecision =
  | { ok: true; explicitDirect: boolean; localMode: SandboxMode | 'inherit' }
  | { ok: false; message: string };

export interface IsolationApprovalRow {
  sessionId: string;
  toolName: string;
  status: string;
  args?: unknown;
  createdAt?: string;
}

type RequestedIsolation =
  | { kind: 'default' }
  | { kind: 'os' }
  | { kind: 'direct' }
  | { kind: 'remote' }
  | { kind: 'container' }
  | { kind: 'unknown' };

export function shellIsolationAvailability(kind: ShellSandboxKind): ShellIsolationAvailability {
  return {
    kind,
    os: new MacOSSandboxProvider().isAvailable() || new LinuxBwrapProvider().isAvailable(),
    remote: new CloudflareComputerProvider().isAvailable()
  };
}

export function requestsDirectIsolation(raw: unknown): boolean {
  return parseRequestedIsolation(raw).kind === 'direct';
}

export function shellCallNeedsDirectApproval(raw: unknown, availability: ShellIsolationAvailability): boolean {
  const decision = decideShellIsolation(raw, availability);
  return decision.ok && decision.explicitDirect;
}

export function decideShellIsolation(raw: unknown, availability: ShellIsolationAvailability): ShellIsolationDecision {
  const requested = parseRequestedIsolation(raw);
  switch (availability.kind) {
    case 'native':
      return decideNative(requested, availability);
    case 'remote_vm':
    case 'microservice':
      return decideOffMachine(requested);
    default: {
      const neverKind: never = availability.kind;
      return neverKind;
    }
  }
}

export function canonicalToolArgs(value: unknown): string {
  return JSON.stringify(sortKeys(value ?? {}));
}

export function approvalGrantsDirectIsolation(
  approvals: readonly IsolationApprovalRow[],
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): boolean {
  return latestMatchingApproval(approvals, sessionId, toolName, args)?.status === 'approved';
}

export function planDirectIsolationHold(
  calls: readonly { name: string; input: unknown }[],
  approvals: readonly IsolationApprovalRow[],
  sessionId: string,
  availability: ShellIsolationAvailability
): { wait: boolean; create: Array<{ toolName: string; args: Record<string, unknown> }> } {
  let wait = false;
  const create: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  for (const call of calls) {
    if (!['bash', 'bg_run', 'work_evidence'].includes(call.name)) continue;
    if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) continue;
    const args = call.input as Record<string, unknown>;
    if (!shellCallNeedsDirectApproval(args.isolation, availability)) continue;
    const latest = latestMatchingApproval(approvals, sessionId, call.name, args);
    if (!latest) {
      wait = true;
      create.push({ toolName: call.name, args });
    } else if (latest.status === 'pending') {
      wait = true;
    }
  }
  return { wait, create };
}

function parseRequestedIsolation(raw: unknown): RequestedIsolation {
  if (raw == null) return { kind: 'default' };
  if (typeof raw !== 'string') return { kind: 'unknown' };
  const token = raw.trim().toLowerCase().replace(/_/g, '-');
  if (token === '' || token === 'auto' || token === 'strongest' || token === 'default') return { kind: 'default' };
  if (token === 'os') return { kind: 'os' };
  if (token === 'direct') return { kind: 'direct' };
  if (token === 'remote' || token === 'cloudflare-computer' || token === 'cf-computer') return { kind: 'remote' };
  if (token === 'container' || token === 'docker' || token === 'podman') return { kind: 'container' };
  return { kind: 'unknown' };
}

function decideNative(requested: RequestedIsolation, availability: ShellIsolationAvailability): ShellIsolationDecision {
  switch (requested.kind) {
    case 'default':
      return availability.os
        ? { ok: true, explicitDirect: false, localMode: 'os' }
        : { ok: true, explicitDirect: false, localMode: 'direct' };
    case 'os':
      return availability.os
        ? { ok: true, explicitDirect: false, localMode: 'os' }
        : { ok: false, message: OS_UNAVAILABLE_REFUSAL };
    case 'direct':
      return { ok: true, explicitDirect: true, localMode: 'direct' };
    case 'remote':
      return availability.remote
        ? { ok: true, explicitDirect: false, localMode: 'cloudflare-computer' }
        : { ok: false, message: REMOTE_UNAVAILABLE_REFUSAL };
    case 'container':
      return { ok: false, message: CONTAINER_ISOLATION_REFUSAL };
    case 'unknown':
      return { ok: false, message: UNKNOWN_ISOLATION_REFUSAL };
    default: {
      const neverRequested: never = requested;
      return neverRequested;
    }
  }
}

function decideOffMachine(requested: RequestedIsolation): ShellIsolationDecision {
  switch (requested.kind) {
    case 'default':
    case 'os':
    case 'remote':
      return { ok: true, explicitDirect: false, localMode: 'inherit' };
    case 'direct':
      return { ok: false, message: DIRECT_NOT_ON_RUNNER_REFUSAL };
    case 'container':
      return { ok: false, message: CONTAINER_ISOLATION_REFUSAL };
    case 'unknown':
      return { ok: false, message: UNKNOWN_ISOLATION_REFUSAL };
    default: {
      const neverRequested: never = requested;
      return neverRequested;
    }
  }
}

function latestMatchingApproval(
  approvals: readonly IsolationApprovalRow[],
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): IsolationApprovalRow | undefined {
  const want = canonicalToolArgs(args);
  const matches = approvals.filter(
    (row) => row.sessionId === sessionId && row.toolName === toolName && canonicalToolArgs(row.args ?? {}) === want
  );
  // Millisecond timestamps cannot order concurrent decisions. Never let an
  // approved row hide an equally recent refusal or still-pending review.
  const statusOrder = ['approved', 'rejected', 'pending'];
  matches.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
    statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  return matches[matches.length - 1];
}
