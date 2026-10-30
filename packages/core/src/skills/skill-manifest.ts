import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequiredSkills } from './mandatory-skill-gate.js';

/**
 * Skill capability-boundary Manifest.
 *
 * Orthogonal to progressive disclosure / lazy-load (skill-disclosure.ts):
 * - disclosure controls *how much skill text* is injected into context
 * - Manifest declares *what the skill is allowed to do* (tools/paths/network/secrets)
 * Runtime enforces Manifest; invalid Manifest fails closed.
 */

export type SkillNetworkPolicy =
  | { mode: 'none' }
  | { mode: 'deny' }
  | { mode: 'allowlist'; hosts: string[] };

export interface SkillManifest {
  /** Semver-ish or integer string; required. */
  version: string;
  /** Tools the skill may invoke. Omitted or empty denies every tool (fail closed). `*` allows the rest. */
  allowTools?: string[];
  /** Tools explicitly denied (wins over allow). */
  denyTools?: string[];
  /** Path prefixes the skill may touch (absolute or workspace-relative). */
  allowPaths?: string[];
  /** Path prefixes denied (wins over allow). */
  denyPaths?: string[];
  /** Network posture. Default none when omitted after validate. */
  network?: SkillNetworkPolicy;
  /** Secret *names* the skill needs (never values). */
  secretNeeds?: string[];
  /**
   * Other skill names satisfied by loading this skill.
   * The mandatory skill gate treats each name as already load_skill'd.
   */
  requiredSkills?: string[];
}

export type SkillManifestValidation =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; error: string };

export type SkillCapabilityCheck =
  | { ok: true }
  | { ok: false; reason: string };

const NAME_RE = /^[A-Za-z0-9_.:/@*-]+$/;

function asStringList(raw: unknown, field: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${field} must be an array of strings` };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `${field} entries must be non-empty strings` };
    }
    const v = item.trim();
    if (field.includes('Tool') && !NAME_RE.test(v)) {
      return { ok: false, error: `${field} entry "${v}" has invalid characters` };
    }
    out.push(v);
  }
  return { ok: true, value: out };
}

function parseNetwork(raw: unknown): { ok: true; value?: SkillNetworkPolicy } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase();
    if (mode === 'none' || mode === 'deny') return { ok: true, value: { mode } };
    return { ok: false, error: `network string must be "none" or "deny" (got "${raw}")` };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'network must be a string or object' };
  }
  const obj = raw as Record<string, unknown>;
  const mode = typeof obj.mode === 'string' ? obj.mode.trim().toLowerCase() : '';
  if (mode === 'none' || mode === 'deny') return { ok: true, value: { mode } };
  if (mode === 'allowlist') {
    const hosts = asStringList(obj.hosts, 'network.hosts');
    if (!hosts.ok) return hosts;
    if (hosts.value.length === 0) return { ok: false, error: 'network.allowlist requires hosts' };
    return { ok: true, value: { mode: 'allowlist', hosts: hosts.value } };
  }
  return { ok: false, error: 'network.mode must be none|deny|allowlist' };
}

/** Validate and normalize a raw Manifest object. Fail closed on any defect. */
export function validateSkillManifest(raw: unknown): SkillManifestValidation {
  if (raw === undefined || raw === null) {
    return { ok: false, error: 'manifest is required' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manifest must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  if (!version) return { ok: false, error: 'manifest.version is required' };

  const allowTools = asStringList(obj.allowTools ?? obj.allow_tools, 'allowTools');
  if (!allowTools.ok) return allowTools;
  const denyTools = asStringList(obj.denyTools ?? obj.deny_tools, 'denyTools');
  if (!denyTools.ok) return denyTools;
  const allowPaths = asStringList(obj.allowPaths ?? obj.allow_paths, 'allowPaths');
  if (!allowPaths.ok) return allowPaths;
  const denyPaths = asStringList(obj.denyPaths ?? obj.deny_paths, 'denyPaths');
  if (!denyPaths.ok) return denyPaths;
  const secretNeeds = asStringList(obj.secretNeeds ?? obj.secret_needs, 'secretNeeds');
  if (!secretNeeds.ok) return secretNeeds;
  const requiredSkills = parseRequiredSkills(obj.requiredSkills ?? obj.required_skills);
  if (!requiredSkills.ok) return requiredSkills;
  const network = parseNetwork(obj.network);
  if (!network.ok) return network;

  const manifest: SkillManifest = {
    version,
    ...(allowTools.value.length ? { allowTools: allowTools.value } : {}),
    ...(denyTools.value.length ? { denyTools: denyTools.value } : {}),
    ...(allowPaths.value.length ? { allowPaths: allowPaths.value } : {}),
    ...(denyPaths.value.length ? { denyPaths: denyPaths.value } : {}),
    ...(network.value ? { network: network.value } : { network: { mode: 'none' } }),
    ...(secretNeeds.value.length ? { secretNeeds: secretNeeds.value } : {}),
    ...(requiredSkills.value.length ? { requiredSkills: requiredSkills.value } : {})
  };
  return { ok: true, manifest };
}

function matchTool(name: string, pattern: string): boolean {
  const n = name.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (p === '*' || p === n) return true;
  if (p.endsWith('*') && n.startsWith(p.slice(0, -1))) return true;
  return false;
}

function pushPathPiece(stack: string[], piece: string): boolean {
  if (piece === '' || piece === '.') return true;
  if (piece === '..') {
    if (stack.length === 0) return false;
    stack.pop();
    return true;
  }
  stack.push(piece);
  return true;
}

/** Lexical path key. `..` that escapes the root is rejected. Does not touch the filesystem. */
export function canonicalSkillPath(input: string): string | undefined {
  const slash = input.replace(/\\/g, '/').trim();
  if (!slash || slash.includes('\0') || slash.includes('://')) return undefined;
  const absolute = slash.startsWith('/') || /^[a-zA-Z]:\//.test(slash);
  const stack: string[] = [];
  for (const piece of slash.split('/')) {
    if (!pushPathPiece(stack, piece)) return undefined;
  }
  const body = stack.join('/');
  if (absolute) return `/${body}`;
  return body || '.';
}

function pathWithin(target: string, prefixRaw: string): boolean {
  const prefix = canonicalSkillPath(prefixRaw);
  if (!prefix) return false;
  if (prefix === '.') return !target.startsWith('/');
  return target === prefix || target.startsWith(`${prefix}/`);
}

function pathBlocked(target: string, allow: string[] | undefined, deny: string[] | undefined): string | undefined {
  const canonical = canonicalSkillPath(target);
  if (!canonical) return `path "${target}" denied by skill manifest`;
  if ((deny ?? []).some((item) => pathWithin(canonical, item))) {
    return `path "${target}" denied by skill manifest`;
  }
  if (!(allow ?? []).some((item) => pathWithin(canonical, item))) {
    return `path "${target}" not in skill manifest allowPaths`;
  }
  return undefined;
}

function toolDecision(manifest: SkillManifest, tool: string | undefined): SkillCapabilityCheck | undefined {
  if (!tool) return undefined;
  const name = tool.trim();
  if (manifest.denyTools?.some((pattern) => matchTool(name, pattern))) {
    return { ok: false, reason: `tool "${name}" denied by skill manifest` };
  }
  if (!(manifest.allowTools ?? []).some((pattern) => matchTool(name, pattern))) {
    return { ok: false, reason: `tool "${name}" not in skill manifest allowTools` };
  }
  return undefined;
}

/** Hostname only. Empty, userinfo, and non-DNS text fail closed. */
export function networkHostFromInput(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.includes('://')) {
    try {
      return normalizeNetworkHost(new URL(text).hostname);
    } catch {
      return undefined;
    }
  }
  return normalizeNetworkHost(text);
}

function normalizeNetworkHost(raw: string): string | undefined {
  const text = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!text || text.includes('@') || text.includes('/') || text.includes(' ') || text.includes('..')) return undefined;
  const host = text.includes(':') && !text.startsWith('[') ? (text.split(':')[0] ?? '') : text;
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return undefined;
  return host;
}

function hostMatches(host: string, allowed: string): boolean {
  const item = normalizeNetworkHost(allowed);
  if (!item) return false;
  return host === item || host.endsWith(`.${item}`);
}

function networkBlocked(net: SkillNetworkPolicy, host: string): SkillCapabilityCheck | undefined {
  switch (net.mode) {
    case 'none':
    case 'deny':
      return { ok: false, reason: `network blocked by skill manifest (mode=${net.mode})` };
    case 'allowlist': {
      const normalized = networkHostFromInput(host);
      if (!normalized || !net.hosts.some((item) => hostMatches(normalized, item))) {
        return { ok: false, reason: `host "${host}" not in skill manifest network allowlist` };
      }
      return undefined;
    }
    default: {
      const neverMode: never = net;
      return neverMode;
    }
  }
}

/** Enforce tool / path / network against an active Manifest. Fail closed. */
export function enforceSkillManifest(
  manifest: SkillManifest,
  action: {
    tool?: string;
    path?: string;
    networkHost?: string;
  }
): SkillCapabilityCheck {
  const tool = toolDecision(manifest, action.tool);
  if (tool) return tool;
  if (action.path) {
    const reason = pathBlocked(action.path, manifest.allowPaths, manifest.denyPaths);
    if (reason) return { ok: false, reason };
  }
  if (action.networkHost !== undefined) {
    const blocked = networkBlocked(manifest.network ?? { mode: 'none' }, action.networkHost);
    if (blocked) return blocked;
  }
  return { ok: true };
}

/**
 * Load Manifest from a parsed frontmatter map (keys: capability / manifest)
 * or a sibling JSON object. Returns undefined when absent; fail-closed error when present but invalid.
 */
export function loadSkillManifestFromMeta(
  meta: Record<string, unknown> | undefined,
  siblingJson?: unknown
): SkillManifestValidation | { ok: true; manifest: undefined } {
  const raw = siblingJson ?? meta?.capability ?? meta?.manifest;
  if (raw === undefined || raw === null) return { ok: true, manifest: undefined };
  if (typeof raw === 'string') {
    try {
      return validateSkillManifest(JSON.parse(raw));
    } catch {
      return { ok: false, error: 'manifest JSON string is invalid' };
    }
  }
  return validateSkillManifest(raw);
}

const SIBLING_MANIFEST_FILES = ['skill.manifest.json', 'capability.json'] as const;

function readSiblingJson(candidate: string, name: string): { ok: true; manifest: unknown } | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(candidate, 'utf8');
  } catch {
    return { ok: false, error: `${name} is unreadable` };
  }
  try {
    return { ok: true, manifest: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: `${name} is not valid JSON` };
  }
}

/** Sibling `skill.manifest.json` / `capability.json`. Missing is ok; broken JSON fails closed. */
export function readSiblingSkillManifest(
  skillDir: string
): { ok: true; manifest: unknown | undefined } | { ok: false; error: string } {
  for (const name of SIBLING_MANIFEST_FILES) {
    const candidate = join(skillDir, name);
    if (!existsSync(candidate)) continue;
    return readSiblingJson(candidate, name);
  }
  return { ok: true, manifest: undefined };
}

/** Invalid sibling or frontmatter manifest fails the skill. Absent manifest stays unrestricted. */
export function manifestForSkillFile(
  skillDir: string,
  meta: Record<string, unknown> | undefined
): { ok: true; manifest: SkillManifest | undefined } | { ok: false; error: string } {
  const sibling = readSiblingSkillManifest(skillDir);
  if (!sibling.ok) return sibling;
  const loaded = loadSkillManifestFromMeta(meta, sibling.manifest);
  if (!loaded.ok) return loaded;
  return { ok: true, manifest: loaded.manifest };
}

/** Planning builtin example Manifest — least privilege for todo planning. */
export const PLANNING_SKILL_MANIFEST: SkillManifest = {
  version: '1.0.0',
  allowTools: ['TodoWrite', 'todo_write', 'load_skill', 'search_skills'],
  denyTools: ['bash', 'bg_run', 'shell'],
  allowPaths: ['.', './'],
  network: { mode: 'none' },
  secretNeeds: []
};
