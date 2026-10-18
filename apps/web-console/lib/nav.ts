export const SECTION_IDS = ['bot', 'chat', 'agents', 'tasks', 'knowledge', 'settings'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const OPS_PANES = ['trajectory', 'health'] as const;
export type OpsPane = (typeof OPS_PANES)[number];
export const DEFAULT_OPS_PANE: OpsPane = 'trajectory';

export const SUB_PAGES = {
  bot: [],
  chat: [],
  agents: ['agents', 'bots', 'teams', 'skills'],
  tasks: ['queue', 'bots', 'runs', 'inbox'],
  knowledge: ['memory', 'ingestion'],
  settings: ['general', 'models', 'behavior', 'safety', 'tools', 'integrations', 'ops']
} as const satisfies Record<SectionId, readonly string[]>;

export type SubPageId<S extends SectionId = SectionId> = (typeof SUB_PAGES)[S][number];

export interface NavLocation {
  section: SectionId;
  sub: string | null;
  /** Set when the location is 设置 → 运维. */
  pane: string | null;
}

export const DEFAULT_LOCATION: NavLocation = { section: 'chat', sub: null, pane: null };

export function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

export function isPlaySection(section: SectionId): boolean {
  return section === 'chat' || section === 'bot';
}

export function isOpsPane(value: string): value is OpsPane {
  return (OPS_PANES as readonly string[]).includes(value);
}

export function subPagesOf(section: SectionId): readonly string[] {
  return SUB_PAGES[section];
}

export function defaultSubOf(section: SectionId): string | null {
  return SUB_PAGES[section][0] ?? null;
}

function opsLocation(paneRaw: string): NavLocation {
  return {
    section: 'settings',
    sub: 'ops',
    pane: isOpsPane(paneRaw) ? paneRaw : DEFAULT_OPS_PANE
  };
}

/** `#/settings/ops/health` → 设置里的运维；旧 `#/ops/health` 同样落到该页。非法值回落默认。 */
export function parseHash(hash: string): NavLocation {
  const raw = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const [sectionRaw = '', subRaw = '', paneRaw = ''] = raw.split('/');
  if (sectionRaw === 'ops') return opsLocation(subRaw);
  if (!isSectionId(sectionRaw)) return DEFAULT_LOCATION;
  const subs = subPagesOf(sectionRaw);
  if (subs.length === 0) return { section: sectionRaw, sub: null, pane: null };
  const sub = subs.includes(subRaw) ? subRaw : defaultSubOf(sectionRaw);
  if (sectionRaw === 'settings' && sub === 'ops') return opsLocation(paneRaw);
  return { section: sectionRaw, sub, pane: null };
}

export function formatHash(loc: { section: SectionId; sub: string | null; pane?: string | null }): string {
  if (loc.section === 'settings' && loc.sub === 'ops') {
    const pane = loc.pane && isOpsPane(loc.pane) ? loc.pane : DEFAULT_OPS_PANE;
    return `#/settings/ops/${pane}`;
  }
  const subs = subPagesOf(loc.section);
  if (subs.length === 0 || !loc.sub || !subs.includes(loc.sub)) return `#/${loc.section}`;
  return `#/${loc.section}/${loc.sub}`;
}

/** Legacy `#/ops/...` and `#/settings/ops` without a pane become the canonical settings hash. */
export function canonicalOpsHash(hash: string): string | null {
  const bare = (hash.split('?')[0] ?? '').trim();
  const path = bare.replace(/^#\/?/, '');
  if (!path) return null;
  const [head, sub] = path.split('/');
  if (head !== 'ops' && !(head === 'settings' && sub === 'ops')) return null;
  const next = formatHash(parseHash(bare.startsWith('#') ? bare : `#/${path}`));
  return next === bare ? null : next;
}

export function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.section === b.section && a.sub === b.sub && a.pane === b.pane;
}
