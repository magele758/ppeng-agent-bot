/**
 * Active skill manifests constrain later tool calls.
 * No manifest ⇒ no extra restriction. A present manifest is a ceiling:
 * every loaded manifest must allow the tool, path, and network host.
 */

import type { SkillManifest } from './skill-manifest.js';
import { enforceSkillManifest, networkHostFromInput } from './skill-manifest.js';

const noted = new Map<string, SkillManifest[]>();

const PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'delete_file', 'apply_patch']);
const SHELL_TOOLS = new Set(['bash', 'bg_run', 'shell', 'work_evidence']);
const NET_HINT = /\b(?:curl|wget|nc|ncat|ssh|scp)\b|https?:\/\//i;

export function resetActiveSkillManifests(sessionId?: string): void {
  if (sessionId) noted.delete(sessionId);
  else noted.clear();
}

export function noteActiveSkillManifest(sessionId: string, manifest: SkillManifest): void {
  const cur = noted.get(sessionId) ?? [];
  const key = JSON.stringify(manifest);
  if (cur.some((item) => JSON.stringify(item) === key)) return;
  cur.push(manifest);
  noted.set(sessionId, cur);
}

function storedManifests(metadata: Record<string, unknown> | undefined): SkillManifest[] {
  const raw = metadata?.activeSkillManifests;
  if (!Array.isArray(raw)) return [];
  const out: SkillManifest[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as SkillManifest).version === 'string') {
      out.push(item as SkillManifest);
    }
  }
  return out;
}

function dedupeManifests(manifests: SkillManifest[]): SkillManifest[] {
  const seen = new Set<string>();
  const out: SkillManifest[] = [];
  for (const manifest of manifests) {
    const key = JSON.stringify(manifest);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(manifest);
  }
  return out;
}

export function manifestsForSession(sessionId: string, metadata?: Record<string, unknown>): SkillManifest[] {
  return dedupeManifests([...storedManifests(metadata), ...(noted.get(sessionId) ?? [])]);
}

interface ManifestSessionStore {
  getSession(id: string): { metadata?: Record<string, unknown> } | undefined;
  updateSession(id: string, patch: { metadata: Record<string, unknown> }): unknown;
}

/** Remember a manifest for this process and, when a session row exists, on metadata. */
export function persistActiveSkillManifest(store: ManifestSessionStore, sessionId: string, manifest: SkillManifest): void {
  noteActiveSkillManifest(sessionId, manifest);
  try {
    const session = store.getSession(sessionId);
    if (!session) return;
    store.updateSession(sessionId, {
      metadata: { ...(session.metadata ?? {}), activeSkillManifests: manifestsForSession(sessionId, session.metadata) }
    });
  } catch {
    /* Writer claim can reject the row write. The in-memory note still applies. */
  }
}

function argsRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function hostFromCommand(command: string): string {
  const match = command.match(/https?:\/\/([^/\s]+)/i);
  if (!match?.[1]) return '';
  return networkHostFromInput(match[1]) ?? '';
}

function shellNetworkHost(record: Record<string, unknown>): string {
  const command = firstString(record, ['command', 'verify_command']) ?? '';
  if (!NET_HINT.test(command)) return '';
  return hostFromCommand(command);
}

function networkHostFor(tool: string, record: Record<string, unknown>): string | undefined {
  const url = firstString(record, ['url']);
  if (url) return networkHostFromInput(url) ?? '';
  if (SHELL_TOOLS.has(tool)) return shellNetworkHost(record);
  if (tool === 'web_fetch' || tool === 'web_search') return '';
  return undefined;
}

function pathForTool(tool: string, record: Record<string, unknown>): string | undefined {
  if (!PATH_TOOLS.has(tool)) return undefined;
  return firstString(record, ['path', 'file', 'file_path', 'cwd']) ?? '.';
}

function actionFromTool(tool: string, args: unknown): { tool: string; path?: string; networkHost?: string } {
  const record = argsRecord(args);
  const path = pathForTool(tool, record);
  const networkHost = networkHostFor(tool, record);
  return {
    tool,
    ...(path !== undefined ? { path } : {}),
    ...(networkHost !== undefined ? { networkHost } : {})
  };
}

export function gateActiveSkillManifests(
  manifests: SkillManifest[],
  tool: string,
  args: unknown
): { ok: true } | { ok: false; reason: string } {
  if (manifests.length === 0) return { ok: true };
  const action = actionFromTool(tool, args);
  for (const manifest of manifests) {
    const decision = enforceSkillManifest(manifest, action);
    if (!decision.ok) return decision;
  }
  return { ok: true };
}

export function splitSkillLoads<T extends { name: string }>(calls: readonly T[]): { loads: T[]; rest: T[] } {
  const loads: T[] = [];
  const rest: T[] = [];
  for (const call of calls) {
    if (call.name === 'load_skill') loads.push(call);
    else rest.push(call);
  }
  return { loads, rest };
}

export function stitchToolResults<T extends { toolCallId: string }>(
  calls: readonly { toolCallId: string }[],
  results: readonly T[]
): T[] {
  const byId = new Map(results.map((result) => [result.toolCallId, result]));
  const ordered: T[] = [];
  for (const call of calls) {
    const found = byId.get(call.toolCallId);
    if (found) ordered.push(found);
  }
  return ordered;
}

/** Finish load_skill before other tools in the same wave, so a new Manifest cannot lose the race. */
export async function executeLoadsBeforeEffects<C extends { name: string; toolCallId: string }, R extends { toolCallId: string }>(
  calls: readonly C[],
  runBatch: (batch: C[]) => Promise<R[]>
): Promise<R[]> {
  const { loads, rest } = splitSkillLoads(calls);
  if (loads.length === 0) return runBatch([...calls]);
  const loaded = await runBatch(loads);
  if (rest.length === 0) return loaded;
  const followed = await runBatch(rest);
  return stitchToolResults(calls, [...loaded, ...followed]);
}

export async function runWithSkillManifest<T extends { ok: boolean; content: string }>(
  context: { session: { id: string; metadata?: Record<string, unknown> } },
  toolName: string,
  args: unknown,
  run: () => Promise<T>
): Promise<T | { ok: false; content: string }> {
  const decision = gateActiveSkillManifests(
    manifestsForSession(context.session.id, context.session.metadata),
    toolName,
    args
  );
  if (!decision.ok) return { ok: false, content: decision.reason };
  return run();
}
