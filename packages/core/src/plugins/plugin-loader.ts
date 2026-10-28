import type { SoftwareExecutor } from '../connectors/software-execution.js';
/**
 * Minimal plugin package contract (Claude/pi-inspired).
 * A plugin is a directory with plugin.json + optional agents/tools/skills/hooks.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AgentSpec, SkillSpec, ToolContract } from '../types.js';
import { discoverAgentFolders } from '../agents/agent-as-folder.js';

export type PluginAuthKind = 'none' | 'bearer' | 'oauth' | 'header';

/** Names only. A plugin manifest must not carry the secret value. */
export interface PluginAuthSpec {
  kind?: PluginAuthKind;
  /** Env var that holds the secret, e.g. `ACME_TOKEN`. */
  secretEnv?: string;
  /** HTTP header name when `kind` is `header`. */
  headerName?: string;
}

export interface PluginToolSpec {
  executor?: SoftwareExecutor;
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PluginToolDecl {
  executor?: SoftwareExecutor;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** Relative paths under the plugin root */
  agents?: string[];
  skills?: string[];
  /** Relative markdown path. Shown to the model only after this connector is granted. */
  instructions?: string;
  /** Per-connector auth. The secret value stays in the named env var. */
  auth?: PluginAuthSpec;
  /**
   * Declarative tools: inline specs or JSON paths. `tools/*.json` is loaded too.
   * They are recorded on `toolDecls` and stay out of `tools` until granted.
   */
  tools?: Array<string | PluginToolSpec>;
  /** Optional hook script paths keyed by phase */
  hooks?: Partial<
    Record<
      'session_start' | 'pre_tool_use' | 'post_tool_use' | 'stop' | 'pre_compact',
      string
    >
  >;
}

export interface LoadedPlugin {
  root: string;
  manifest: PluginManifest;
  agents: AgentSpec[];
  skills: SkillSpec[];
  /**
   * Tools exposed to the model. Always empty here — the connector registry
   * adds `toolDecls` only after the plugin is granted.
   */
  tools: ToolContract<any>[];
  toolDecls: PluginToolDecl[];
  /** Markdown from `manifest.instructions`, or empty when missing. */
  instructionText: string;
  authKind: PluginAuthKind;
  secretEnv?: string;
  headerName?: string;
  hookEnv: Record<string, string>;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function loadAgentFile(path: string): AgentSpec | undefined {
  const raw = readJson<Partial<AgentSpec> & { id?: string }>(path);
  if (!raw?.id || !raw.name || !raw.role || !raw.instructions) return undefined;
  return {
    id: raw.id,
    name: raw.name,
    role: raw.role,
    instructions: raw.instructions,
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [],
    harnessRole: raw.harnessRole,
    autonomous: raw.autonomous,
    model: raw.model,
    allowedTools: raw.allowedTools,
    domainId: raw.domainId
  };
}

function loadSkillMd(path: string, pluginId: string): SkillSpec | undefined {
  try {
    const text = readFileSync(path, 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(text);
    let name = '';
    let description = '';
    let body = text;
    if (fm) {
      body = fm[2] ?? '';
      for (const line of (fm[1] ?? '').split('\n')) {
        const m = /^(\w+):\s*(.*)$/.exec(line.trim());
        if (!m) continue;
        if (m[1] === 'name') name = m[2]!.replace(/^["']|["']$/g, '');
        if (m[1] === 'description') description = m[2]!.replace(/^["']|["']$/g, '');
      }
    }
    if (!name) {
      const h = /^#\s+(.+)$/m.exec(body);
      name = h?.[1]?.trim() || path.split('/').slice(-2, -1)[0] || 'skill';
    }
    return {
      id: `${pluginId}/${name}`,
      name,
      description: description || name,
      content: body.trim(),
      source: 'workspace',
      skillPath: path
    };
  } catch {
    return undefined;
  }
}

const AUTH_KINDS = new Set<PluginAuthKind>(['none', 'bearer', 'oauth', 'header']);
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,64}$/;

function cleanEnvName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return ENV_NAME_RE.test(trimmed) ? trimmed : undefined;
}

function cleanHeaderName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return HEADER_NAME_RE.test(trimmed) ? trimmed : undefined;
}

function parseAuth(raw: PluginAuthSpec | undefined): {
  authKind: PluginAuthKind;
  secretEnv?: string;
  headerName?: string;
} {
  const kind = raw?.kind;
  const authKind = kind && AUTH_KINDS.has(kind) ? kind : 'none';
  const secretEnv = cleanEnvName(raw?.secretEnv);
  const headerName = cleanHeaderName(raw?.headerName);
  return {
    authKind,
    ...(secretEnv ? { secretEnv } : {}),
    ...(headerName ? { headerName } : {})
  };
}

/** Reject paths that leave the plugin root, including via symlink. */
function resolveInside(root: string, rel: string): string | undefined {
  if (!rel || rel.includes('\0')) return undefined;
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return undefined;
  if (!existsSync(abs)) return undefined;
  try {
    const realRoot = realpathSync(rootAbs);
    const realAbs = realpathSync(abs);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) return undefined;
    return realAbs;
  } catch {
    return undefined;
  }
}

function readInstructions(root: string, rel: string | undefined): string {
  if (!rel?.trim()) return '';
  const abs = resolveInside(root, rel.trim());
  if (!abs) return '';
  try {
    return readFileSync(abs, 'utf8').trim();
  } catch {
    return '';
  }
}

function toolDeclFromUnknown(raw: unknown): PluginToolDecl | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  if (!TOOL_NAME_RE.test(name)) return undefined;
  const description =
    typeof rec.description === 'string' && rec.description.trim() ? rec.description.trim() : name;
  const inputSchema =
    rec.inputSchema && typeof rec.inputSchema === 'object' && !Array.isArray(rec.inputSchema)
      ? (rec.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
  return { name, description, inputSchema, ...(rec.executor ? {executor: rec.executor as SoftwareExecutor} : {}) };
}

function readToolFile(root: string, rel: string): PluginToolDecl | undefined {
  const abs = resolveInside(root, rel);
  if (!abs) return undefined;
  try {
    return toolDeclFromUnknown(JSON.parse(readFileSync(abs, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function loadToolDecls(root: string, manifest: PluginManifest): PluginToolDecl[] {
  const decls: PluginToolDecl[] = [];
  const seen = new Set<string>();
  const push = (decl: PluginToolDecl | undefined) => {
    if (!decl || seen.has(decl.name)) return;
    seen.add(decl.name);
    decls.push(decl);
  };
  for (const entry of manifest.tools ?? []) {
    if (typeof entry === 'string') push(readToolFile(root, entry));
    else push(toolDeclFromUnknown(entry));
  }
  const toolsDir = join(root, 'tools');
  if (existsSync(toolsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(toolsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      push(readToolFile(root, join('tools', name)));
    }
  }
  return decls;
}


/** Manifest agents + agents/*.json + agents/<slug>/ folders (eval default-on). */
function loadPluginAgents(root: string, manifest: { agents?: string[] }): AgentSpec[] {
  const agents: AgentSpec[] = [];
  for (const rel of manifest.agents ?? []) {
    const a = loadAgentFile(join(root, rel));
    if (a) agents.push(a);
  }
  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return agents;
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith('.json')) continue;
    const a = loadAgentFile(join(agentsDir, f));
    if (a && !agents.some((x) => x.id === a.id)) agents.push(a);
  }
  for (const folder of discoverAgentFolders(agentsDir)) {
    if (!agents.some((x) => x.id === folder.agent.id)) agents.push(folder.agent);
  }
  return agents;
}

export function loadPluginFromDir(root: string): LoadedPlugin | undefined {
  const manifestPath = join(root, 'plugin.json');
  const alt = join(root, '.ppeng-plugin', 'plugin.json');
  const path = existsSync(manifestPath) ? manifestPath : existsSync(alt) ? alt : '';
  if (!path) return undefined;
  const manifest = readJson<PluginManifest>(path);
  if (!manifest?.id || !manifest.name) return undefined;

  const agents = loadPluginAgents(root, manifest);

  const skills: SkillSpec[] = [];
  for (const rel of manifest.skills ?? []) {
    const s = loadSkillMd(join(root, rel), manifest.id);
    if (s) skills.push(s);
  }
  const skillsDir = join(root, 'skills');
  if (existsSync(skillsDir)) {
    for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
      const skillMd = ent.isDirectory()
        ? join(skillsDir, ent.name, 'SKILL.md')
        : ent.name === 'SKILL.md'
          ? join(skillsDir, ent.name)
          : '';
      if (skillMd && existsSync(skillMd)) {
        const s = loadSkillMd(skillMd, manifest.id);
        if (s && !skills.some((x) => x.name === s.name)) skills.push(s);
      }
    }
  }

  const hookEnv: Record<string, string> = {};
  const hookMap: Record<string, string> = {
    session_start: 'RAW_AGENT_HOOK_SESSION_START',
    pre_tool_use: 'RAW_AGENT_HOOK_PRE_TOOL',
    post_tool_use: 'RAW_AGENT_HOOK_POST_TOOL',
    stop: 'RAW_AGENT_HOOK_STOP',
    pre_compact: 'RAW_AGENT_HOOK_PRE_COMPACT'
  };
  for (const [phase, rel] of Object.entries(manifest.hooks ?? {})) {
    const abs = join(root, rel);
    if (existsSync(abs) && hookMap[phase]) {
      hookEnv[hookMap[phase]!] = abs;
    }
  }

  const auth = parseAuth(manifest.auth);
  return {
    root,
    manifest,
    agents,
    skills,
    tools: [],
    toolDecls: loadToolDecls(root, manifest),
    instructionText: readInstructions(root, manifest.instructions),
    authKind: auth.authKind,
    ...(auth.secretEnv ? { secretEnv: auth.secretEnv } : {}),
    ...(auth.headerName ? { headerName: auth.headerName } : {}),
    hookEnv
  };
}

/**
 * Discover plugins under `dirs` (each child directory with plugin.json).
 */
export function discoverPlugins(dirs: string[]): LoadedPlugin[] {
  const out: LoadedPlugin[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(dir, d.name));
    } catch {
      continue;
    }
    // Also allow the dir itself to be a plugin root
    const self = loadPluginFromDir(dir);
    if (self) out.push(self);
    for (const child of entries) {
      const p = loadPluginFromDir(child);
      if (p) out.push(p);
    }
  }
  return out;
}

export function mergePlugins(plugins: LoadedPlugin[]): {
  agents: AgentSpec[];
  skills: SkillSpec[];
  hookEnv: Record<string, string>;
} {
  const agents: AgentSpec[] = [];
  const skills: SkillSpec[] = [];
  const hookEnv: Record<string, string> = {};
  for (const p of plugins) {
    for (const a of p.agents) {
      const i = agents.findIndex((x) => x.id === a.id);
      if (i >= 0) agents[i] = a;
      else agents.push(a);
    }
    for (const s of p.skills) {
      const i = skills.findIndex((x) => x.name === s.name);
      if (i >= 0) skills[i] = s;
      else skills.push(s);
    }
    Object.assign(hookEnv, p.hookEnv);
  }
  return { agents, skills, hookEnv };
}

/** Parse RAW_AGENT_PLUGINS_DIR (colon/comma-separated). */
export function pluginDirsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.RAW_AGENT_PLUGINS_DIR?.trim();
  if (!raw) return [];
  return raw.split(/[:;,]/).map((s) => s.trim()).filter(Boolean);
}
