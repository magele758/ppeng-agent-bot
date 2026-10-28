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
  /** Tools the skill may invoke. Empty allow + empty deny ⇒ no tool restriction. */
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
  const network = parseNetwork(obj.network);
  if (!network.ok) return network;

  const manifest: SkillManifest = {
    version,
    ...(allowTools.value.length ? { allowTools: allowTools.value } : {}),
    ...(denyTools.value.length ? { denyTools: denyTools.value } : {}),
    ...(allowPaths.value.length ? { allowPaths: allowPaths.value } : {}),
    ...(denyPaths.value.length ? { denyPaths: denyPaths.value } : {}),
    ...(network.value ? { network: network.value } : { network: { mode: 'none' } }),
    ...(secretNeeds.value.length ? { secretNeeds: secretNeeds.value } : {})
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

function pathBlocked(target: string, allow: string[] | undefined, deny: string[] | undefined): string | undefined {
  const t = target.replace(/\\/g, '/');
  if (deny?.some((d) => t === d || t.startsWith(d.replace(/\/?$/, '/')))) {
    return `path "${target}" denied by skill manifest`;
  }
  if (allow && allow.length > 0) {
    const ok = allow.some((a) => t === a || t.startsWith(a.replace(/\/?$/, '/')));
    if (!ok) return `path "${target}" not in skill manifest allowPaths`;
  }
  return undefined;
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
  if (action.tool) {
    const tool = action.tool.trim();
    if (manifest.denyTools?.some((p) => matchTool(tool, p))) {
      return { ok: false, reason: `tool "${tool}" denied by skill manifest` };
    }
    if (manifest.allowTools && manifest.allowTools.length > 0) {
      if (!manifest.allowTools.some((p) => matchTool(tool, p))) {
        return { ok: false, reason: `tool "${tool}" not in skill manifest allowTools` };
      }
    }
  }
  if (action.path) {
    const reason = pathBlocked(action.path, manifest.allowPaths, manifest.denyPaths);
    if (reason) return { ok: false, reason };
  }
  if (action.networkHost !== undefined) {
    const net = manifest.network ?? { mode: 'none' as const };
    const host = action.networkHost.trim().toLowerCase();
    if (net.mode === 'none' || net.mode === 'deny') {
      return { ok: false, reason: `network blocked by skill manifest (mode=${net.mode})` };
    }
    if (net.mode === 'allowlist') {
      const ok = net.hosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
      if (!ok) return { ok: false, reason: `host "${action.networkHost}" not in skill manifest network allowlist` };
    }
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

/** Planning builtin example Manifest — least privilege for todo planning. */
export const PLANNING_SKILL_MANIFEST: SkillManifest = {
  version: '1.0.0',
  allowTools: ['TodoWrite', 'todo_write', 'load_skill', 'search_skills'],
  denyTools: ['bash', 'bg_run', 'shell'],
  allowPaths: ['.', './'],
  network: { mode: 'none' },
  secretNeeds: []
};
