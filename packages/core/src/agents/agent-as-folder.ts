/**
 * Agent-as-folder path: agents live in directories (like skills/), not only flat JSON.
 *
 * Layout (preferred):
 *   agents/<slug>/agent.json   — required AgentSpec fields (+ optional eval)
 *   agents/<slug>/AGENT.md     — optional; overrides instructions when present
 *
 * Back-compat: flat agents/*.json still loads via plugin-loader.
 *
 * Eval defaults ON for folder agents unless agent.json sets "eval": false.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSpec } from '../types.js';

export type AgentFolderRaw = Partial<AgentSpec> & {
  id?: string;
  name?: string;
  role?: string;
  instructions?: string;
  /** When omitted, eval is default-on. Set false to opt out. */
  eval?: boolean | 0 | 1 | '0' | '1' | 'false' | 'true';
};

export type AgentAsFolder = {
  /** Absolute folder path (agents/<slug>). */
  root: string;
  agent: AgentSpec;
  /** Eval participation; true unless explicitly disabled in agent.json. */
  evalEnabled: boolean;
};

/** Eval is default-on; only an explicit falsey `eval` opts out. */
export function agentEvalDefaultOn(raw?: Pick<AgentFolderRaw, 'eval'> | null): boolean {
  if (raw == null || !Object.prototype.hasOwnProperty.call(raw, 'eval')) return true;
  const v = raw.eval;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return true;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function toAgentSpec(raw: AgentFolderRaw): AgentSpec | undefined {
  if (!raw?.id || !raw.name || !raw.role || typeof raw.instructions !== 'string') return undefined;
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

/**
 * Load one agent folder. Returns undefined when agent.json is missing/invalid.
 * AGENT.md, when present and non-empty, replaces instructions.
 */
export function loadAgentFromFolder(dir: string): AgentAsFolder | undefined {
  const jsonPath = join(dir, 'agent.json');
  if (!existsSync(jsonPath)) return undefined;
  const raw = readJson<AgentFolderRaw>(jsonPath);
  if (!raw) return undefined;

  const mdPath = join(dir, 'AGENT.md');
  if (existsSync(mdPath)) {
    try {
      const md = readFileSync(mdPath, 'utf8').trim();
      if (md) raw.instructions = md;
    } catch {
      /* keep json instructions */
    }
  }

  const agent = toAgentSpec(raw);
  if (!agent) return undefined;
  return {
    root: dir,
    agent,
    evalEnabled: agentEvalDefaultOn(raw)
  };
}

/** Discover agent folders under an agents/ root (skips flat *.json files). */
export function discoverAgentFolders(agentsRoot: string): AgentAsFolder[] {
  if (!existsSync(agentsRoot)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(agentsRoot);
  } catch {
    return [];
  }
  const out: AgentAsFolder[] = [];
  for (const name of names) {
    const full = join(agentsRoot, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const loaded = loadAgentFromFolder(full);
    if (loaded) out.push(loaded);
  }
  return out;
}

/** Agents that should participate in eval by default (evalEnabled !== false). */
export function agentsWithEvalDefaultOn(folders: AgentAsFolder[]): AgentSpec[] {
  return folders.filter((f) => f.evalEnabled).map((f) => f.agent);
}
