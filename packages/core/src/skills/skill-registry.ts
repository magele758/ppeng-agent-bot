import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { botSkillId } from './bot-scope.js';
import type { SkillSpec } from '../types.js';
import { manifestForSkillFile } from './skill-manifest.js';

export type SkillFrontmatterValue = string | string[];

function normalizeFrontmatterText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseInlineList(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return inner
    .split(',')
    .map((item) => parseScalar(item))
    .filter(Boolean);
}

function parseFrontmatterMeta(raw: string): Record<string, SkillFrontmatterValue> {
  const meta: Record<string, SkillFrontmatterValue> = {};
  let activeListKey: string | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.+)\s*$/);
    if (activeListKey && listMatch) {
      const current = meta[activeListKey];
      if (Array.isArray(current)) {
        current.push(parseScalar(listMatch[1] ?? ''));
      } else {
        meta[activeListKey] = [parseScalar(listMatch[1] ?? '')];
      }
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!kvMatch) {
      activeListKey = null;
      continue;
    }

    const key = kvMatch[1]!.trim();
    const rawValue = kvMatch[2] ?? '';
    activeListKey = null;
    if (!rawValue.trim()) {
      meta[key] = [];
      activeListKey = key;
      continue;
    }

    const inlineList = parseInlineList(rawValue);
    if (inlineList !== null) {
      meta[key] = inlineList;
      continue;
    }

    meta[key] = parseScalar(rawValue);
  }

  return meta;
}

function frontmatterString(meta: Record<string, SkillFrontmatterValue>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0]!.trim();
    }
  }
  return undefined;
}

function frontmatterList(meta: Record<string, SkillFrontmatterValue>, ...keys: string[]): string[] | undefined {
  const values: string[] = [];
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        values.push(normalized);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = item.trim();
        if (normalized) {
          values.push(normalized);
        }
      }
    }
  }

  const deduped = [...new Set(values)];
  return deduped.length > 0 ? deduped : undefined;
}

export function parseSkillFrontmatter(text: string): { meta: Record<string, SkillFrontmatterValue>; body: string } {
  const normalized = normalizeFrontmatterText(text);
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    return { meta: {}, body: normalized.trim() };
  }

  return {
    meta: parseFrontmatterMeta(normalized.slice(4, end).trim()),
    body: normalized.slice(end + '\n---\n'.length).trim()
  };
}

/** 同名时后者覆盖前者（用于 ~/.agents 覆盖仓库 skills）。 */
export function mergeSkillsByName(primary: SkillSpec[], override: SkillSpec[]): SkillSpec[] {
  const m = new Map<string, SkillSpec>();
  for (const s of primary) {
    m.set(s.ownerBotId ? botSkillId(s.ownerBotId, s.name) : s.name, s);
  }
  for (const s of override) {
    m.set(s.ownerBotId ? botSkillId(s.ownerBotId, s.name) : s.name, s);
  }
  return Array.from(m.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function loadSkillsFromTree(
  rootDir: string,
  source: NonNullable<SkillSpec['source']>,
  repoRootForRelative?: string
): Promise<SkillSpec[]> {
  try {
    const stack = [rootDir];
    const files: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name === 'SKILL.md') {
          files.push(fullPath);
        }
      }
    }

    const skills: SkillSpec[] = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const parsed = parseSkillFrontmatter(text);
      const name = frontmatterString(parsed.meta, 'name') ?? (basename(dirname(file)) || `${source}-skill`);
      const description = frontmatterString(parsed.meta, 'description') ?? `${source} skill`;
      const ownerBotId = source === 'user' ? frontmatterString(parsed.meta, 'owner-bot') : undefined;
      const sharedBotIds = ownerBotId ? frontmatterList(parsed.meta, 'shared-bots') ?? [] : undefined;
      const id = ownerBotId ? botSkillId(ownerBotId, name) : frontmatterString(parsed.meta, 'id') ?? name;
      const aliases = frontmatterList(parsed.meta, 'aliases', 'alias');
      const triggerWords = frontmatterList(
        parsed.meta,
        'triggerWords',
        'trigger_words',
        'trigger-words',
        'triggers',
        'keywords'
      );
      const relPath =
        repoRootForRelative && file.startsWith(repoRootForRelative)
          ? relative(repoRootForRelative, file)
          : undefined;
      const loadedManifest = manifestForSkillFile(dirname(file), parsed.meta as Record<string, unknown>);
      if (!loadedManifest.ok) continue;
      skills.push({
        id,
        ownerBotId,
        sharedBotIds,
        name,
        description,
        content: parsed.body,
        promptFragment: parsed.body.slice(0, 4000),
        source,
        skillPath: relPath,
        aliases,
        triggerWords,
        manifest: loadedManifest.manifest
      });
    }

    return skills.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export async function loadWorkspaceSkills(repoRoot: string): Promise<SkillSpec[]> {
  return loadSkillsFromTree(join(repoRoot, 'skills'), 'workspace', repoRoot);
}

/**
 * `stateDir/skills/**\/SKILL.md`：经 Lab 审批落地的用户技能（source='user'）。
 * 合并优先级：workspace < user(stateDir) < ~/.agents（见 PromptBuilder.allSkills）。
 */
export async function loadStateDirSkills(stateDir: string | undefined): Promise<SkillSpec[]> {
  if (!stateDir) return [];
  return loadSkillsFromTree(join(stateDir, 'skills'), 'user');
}

/** 用户主目录下 ~/.agents 目录树中的 SKILL.md（或 RAW_AGENT_AGENTS_SKILLS_DIR）。RAW_AGENT_AGENTS_SKILLS=0 可关闭。 */
export async function loadAgentsDirSkills(): Promise<SkillSpec[]> {
  const off = String(process.env.RAW_AGENT_AGENTS_SKILLS ?? '').trim().toLowerCase();
  if (off === '0' || off === 'false' || off === 'no') {
    return [];
  }
  const root = process.env.RAW_AGENT_AGENTS_SKILLS_DIR?.trim() || join(homedir(), '.agents');
  return loadSkillsFromTree(root, 'agents');
}
