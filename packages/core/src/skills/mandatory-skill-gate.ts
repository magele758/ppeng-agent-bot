/**
 * Mandatory skill gate for high-risk surfaces.
 *
 * Shopping / login / outbound-send / payment / site-playbooks tools fail closed
 * unless this session has successfully load_skill'd every required skill name.
 * A loaded skill's Manifest `requiredSkills` also counts as satisfied — loading
 * S satisfies S and each name it declares.
 *
 * Always on for the listed surfaces. Not an env flag.
 * Orthogonal to skill-manifest-gate (that one is a ceiling on what a loaded
 * skill may do). This gate is a floor: the surface may not run at all until
 * the matching skill is loaded. Auto-review and Manifest allowTools still apply.
 */

import type { SkillManifest } from './skill-manifest.js';

export type MandatorySkillSurface =
  | 'shopping'
  | 'login'
  | 'outbound-send'
  | 'payment'
  | 'site-playbooks';

/** Canonical skill name the model must load_skill for each surface. */
export const MANDATORY_SKILL_NAMES = {
  shopping: 'shopping',
  login: 'login',
  outboundSend: 'outbound-send',
  payment: 'payment',
  sitePlaybooks: 'site-playbooks'
} as const;

const SHOPPING = MANDATORY_SKILL_NAMES.shopping;
const LOGIN = MANDATORY_SKILL_NAMES.login;
const OUTBOUND = MANDATORY_SKILL_NAMES.outboundSend;
const PAYMENT = MANDATORY_SKILL_NAMES.payment;
const SITE_PLAYBOOKS = MANDATORY_SKILL_NAMES.sitePlaybooks;

/** Tools that always belong to a surface, whatever the arguments. */
const ALWAYS_GATED: Record<string, { surface: MandatorySkillSurface; skills: readonly string[] }> = {
  collect_credentials: { surface: 'login', skills: [LOGIN] },
  vault_get: { surface: 'login', skills: [LOGIN] },
  schedule_social_post: { surface: 'outbound-send', skills: [OUTBOUND] },
  browser_navigate: { surface: 'site-playbooks', skills: [SITE_PLAYBOOKS] }
};

/**
 * Browser commerce tools are gated only when a session flag or a tool arg
 * says this call is a purchase / checkout. Ordinary browsing stays open.
 */
export const SHOPPING_BROWSER_TOOLS = ['browser_click', 'browser_type'] as const;

const CHECKOUT_ARG_KEYS = ['checkout', 'purchase', 'shopping'] as const;

const PAYMENT_VAULT_FIELDS = new Set(['cardnumber', 'cvv']);
const PAYMENT_FORM_FIELDS = new Set(['cardnumber', 'card', 'cvv']);

const SKILL_NAME_RE = /^[A-Za-z0-9_.:/@*-]+$/;

export interface MandatorySkillRequirement {
  surface: MandatorySkillSurface;
  /** Every name must already be loaded. */
  skills: readonly string[];
}

export type MandatorySkillDecision = { ok: true } | { ok: false; content: string };

const loadedBySession = new Map<string, Set<string>>();

export function resetLoadedMandatorySkills(sessionId?: string): void {
  if (sessionId) loadedBySession.delete(sessionId);
  else loadedBySession.clear();
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function skillSet(metadata: Record<string, unknown> | undefined, sessionId: string): Set<string> {
  const set = new Set<string>(loadedBySession.get(sessionId) ?? []);
  const raw = metadata?.loadedSkillNames;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) set.add(normalizeSkillName(item));
    }
  }
  return set;
}

export function loadedSkillNamesForSession(sessionId: string, metadata?: Record<string, unknown>): string[] {
  return [...skillSet(metadata, sessionId)];
}

interface SkillSessionStore {
  getSession(id: string): { metadata?: Record<string, unknown> } | undefined;
  updateSession(id: string, patch: { metadata: Record<string, unknown> }): unknown;
}

function persistNames(store: SkillSessionStore | undefined, sessionId: string, names: Set<string>): void {
  loadedBySession.set(sessionId, names);
  if (!store) return;
  try {
    const session = store.getSession(sessionId);
    if (!session) return;
    store.updateSession(sessionId, {
      metadata: { ...(session.metadata ?? {}), loadedSkillNames: [...names] }
    });
  } catch {
    /* Writer claim can reject the row write. The in-memory note still applies. */
  }
}

/** Record a successful load_skill. Manifest.requiredSkills are satisfied too. */
export function noteLoadedSkill(
  sessionId: string,
  skillName: string,
  manifest?: Pick<SkillManifest, 'requiredSkills'> | null,
  metadata?: Record<string, unknown>,
  store?: SkillSessionStore
): string[] {
  const names = skillSet(metadata, sessionId);
  const primary = normalizeSkillName(skillName);
  if (primary) names.add(primary);
  for (const required of manifest?.requiredSkills ?? []) {
    const normalized = normalizeSkillName(required);
    if (normalized) names.add(normalized);
  }
  persistNames(store, sessionId, names);
  return [...names];
}

function argsRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'checkout' || text === 'purchase';
}

function checkoutFlagOn(record: Record<string, unknown>): boolean {
  for (const key of CHECKOUT_ARG_KEYS) {
    if (truthyFlag(record[key])) return true;
  }
  const intent = record.intent ?? record.purpose ?? record.flow ?? record.surface;
  if (typeof intent === 'string') {
    const text = intent.trim().toLowerCase();
    if (text === 'checkout' || text === 'purchase' || text === 'shopping' || text === 'payment') return true;
  }
  return false;
}

function sessionCheckout(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (truthyFlag(metadata.checkout) || truthyFlag(metadata.shopping)) return true;
  const surface = metadata.surface ?? metadata.browserSurface;
  if (typeof surface === 'string') {
    const text = surface.trim().toLowerCase();
    if (text === 'checkout' || text === 'shopping' || text === 'purchase') return true;
  }
  return false;
}

function vaultRefField(ref: string): string {
  const text = ref.trim();
  const colon = text.lastIndexOf(':');
  if (colon < 0) return '';
  return text.slice(colon + 1).trim().toLowerCase();
}

function vaultFillTouchesCard(record: Record<string, unknown>): boolean {
  const fields = record.fields;
  if (!Array.isArray(fields)) return false;
  for (const item of fields) {
    if (!item || typeof item !== 'object') continue;
    const ref = (item as Record<string, unknown>).ref;
    if (typeof ref === 'string' && PAYMENT_VAULT_FIELDS.has(vaultRefField(ref))) return true;
  }
  return false;
}

function formField(record: Record<string, unknown>): string {
  const raw = record.field ?? record.kind;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function push(out: MandatorySkillRequirement[], surface: MandatorySkillSurface, skills: readonly string[]): void {
  if (out.some((item) => item.surface === surface)) return;
  out.push({ surface, skills });
}

/**
 * Surface requirements for this call. Empty means the tool is not on a gated surface.
 * `secure_form` / `vault_fill` / browser click+type are conditional.
 */
export function mandatorySkillsForTool(
  toolName: string,
  args: unknown,
  metadata?: Record<string, unknown>
): MandatorySkillRequirement[] {
  const tool = toolName.trim();
  const record = argsRecord(args);
  const out: MandatorySkillRequirement[] = [];

  const always = ALWAYS_GATED[tool];
  if (always) {
    push(out, always.surface, always.skills);
  }

  if (tool === 'vault_fill') {
    push(out, 'shopping', [SHOPPING]);
    if (vaultFillTouchesCard(record)) push(out, 'payment', [PAYMENT]);
  }

  if (tool === 'secure_form' && PAYMENT_FORM_FIELDS.has(formField(record))) {
    push(out, 'payment', [PAYMENT]);
  }

  if ((SHOPPING_BROWSER_TOOLS as readonly string[]).includes(tool)) {
    if (checkoutFlagOn(record) || sessionCheckout(metadata)) push(out, 'shopping', [SHOPPING]);
  }

  return out;
}

export function mandatorySkillDenial(missing: readonly string[]): string {
  const names = missing.map((name) => name.trim()).filter(Boolean);
  const listed = names.map((name) => `load_skill(${name})`).join(' and ');
  return `Mandatory skill required before this tool can run. Call ${listed} first. Missing: ${names.join(', ')}.`;
}

/** Fail closed when a gated surface's required skill names are not loaded. */
export function gateMandatorySkills(
  loaded: readonly string[],
  toolName: string,
  args: unknown,
  metadata?: Record<string, unknown>
): MandatorySkillDecision {
  const requirements = mandatorySkillsForTool(toolName, args, metadata);
  if (requirements.length === 0) return { ok: true };
  const have = new Set(loaded.map((name) => normalizeSkillName(name)));
  const missing: string[] = [];
  for (const requirement of requirements) {
    for (const skill of requirement.skills) {
      const key = normalizeSkillName(skill);
      if (!key || have.has(key) || missing.includes(skill)) continue;
      missing.push(skill);
    }
  }
  if (missing.length === 0) return { ok: true };
  return { ok: false, content: mandatorySkillDenial(missing) };
}

export function gateMandatorySkillsForSession(
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
  toolName: string,
  args: unknown
): MandatorySkillDecision {
  return gateMandatorySkills(loadedSkillNamesForSession(sessionId, metadata), toolName, args, metadata);
}

/** Names declared by a Manifest. Invalid entries fail the Manifest (fail closed). */
export function parseRequiredSkills(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'requiredSkills must be an array of strings' };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: 'requiredSkills entries must be non-empty strings' };
    }
    const name = item.trim();
    if (!SKILL_NAME_RE.test(name)) {
      return { ok: false, error: `requiredSkills entry "${name}" has invalid characters` };
    }
    out.push(name);
  }
  return { ok: true, value: out };
}
