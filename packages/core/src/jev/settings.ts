/**
 * Jev entry + assemblable insertion points. daemon_control KV.
 * No RAW_AGENT_* feature switch. Missing entry ⇒ chain stays off.
 * An API key in the environment is only a secret fallback after an entry is saved.
 */

export const JEV_SETTINGS_KEY = 'jev_settings';

/** Stable insertion-point ids that actually change host control flow. */
export const JEV_POINT_IDS = [
  'goalGate',
  'toolGate',
  'compact',
  'route',
  'contextSelect',
  'toolSelect',
  'skillSelect',
  'sagaGate',
  'memorySelect',
  'recoveryChoice',
  'preTurn',
  'ptcDecide'
] as const;
export type JevPointId = (typeof JEV_POINT_IDS)[number];

export type JevProfile = 'off' | 'mini' | 'normal' | 'full' | 'max' | 'custom';

export const JEV_PROFILES: readonly JevProfile[] = [
  'off',
  'mini',
  'normal',
  'full',
  'max',
  'custom'
];

/** Preset → default point set. `off` / `custom` are not listed. */
export const JEV_PROFILE_POINTS: Record<
  Exclude<JevProfile, 'off' | 'custom'>,
  readonly JevPointId[]
> = {
  /** mini forbids static Node I/O in agent-loop; insert nothing by default. */
  mini: [],
  normal: ['goalGate'],
  full: ['goalGate', 'toolGate'],
  max: ['goalGate', 'toolGate', 'compact', 'route']
};

export interface JevModuleFlags {
  goalGate: boolean;
  toolGate: boolean;
  compact: boolean;
  route: boolean;
  contextSelect: boolean;
  toolSelect: boolean;
  skillSelect: boolean;
  sagaGate: boolean;
  memorySelect: boolean;
  recoveryChoice: boolean;
  preTurn: boolean;
  /** Custom-only: inject `jev` into PTC cells for semantic noul/choice. */
  ptcDecide: boolean;
}

export type JevPoints = JevModuleFlags;

export interface JevSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Assembly mode. Independent of loop `assemblyPreset`.
   * `off` never calls Jev even with an entry.
   */
  profile: JevProfile;
  /**
   * Custom checkboxes. Only honored when `profile === 'custom'`.
   * Preserved across preset switches so the user can flip back.
   */
  points: JevPoints;
  /**
   * Legacy mirror of `points` (pre-profile). Kept for older readers;
   * writers keep both in sync.
   */
  modules: JevModuleFlags;
  /**
   * Legacy: derived. True iff the master switch is on, profile !== 'off', and baseUrl is set.
   * Prefer `armed` + `profile` + `activePoints`.
   */
  enabled: boolean;
  /**
   * Master switch on the 实验特性 row. Off never calls Jev and does not rewrite `profile`.
   * Missing on old KV means on iff profile !== 'off'.
   */
  armed: boolean;
  updatedAt: string;
}

export interface JevSettingsPatch {
  baseUrl?: string;
  /** Omit or blank keeps the stored key. */
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  profile?: JevProfile;
  /** Partial custom points; only applied when present. */
  points?: Partial<JevPoints>;
  /**
   * Master switch. Off keeps the saved profile. On while profile is `off` lands on `normal` (标准).
   */
  armed?: boolean;
  /** @deprecated Prefer `profile` / `points`. Mapped onto custom + points. */
  enabled?: boolean;
  /** @deprecated Prefer `points`. Merged into points/modules. */
  modules?: Partial<JevModuleFlags>;
}

export interface JevSettingsPublic {
  configured: boolean;
  baseUrl: string;
  apiKeySet: boolean;
  model: string;
  profile: JevProfile;
  points: JevPoints;
  /** Effective insertion ids for the current profile (+ entry). */
  activePoints: JevPointId[];
  /** configured && activePoints.length > 0 */
  chained: boolean;
  /** Master switch. Off means Jev is not called. */
  armed: boolean;
  /** Legacy: armed && profile !== 'off' && configured */
  enabled: boolean;
  modules: JevModuleFlags;
  active: JevModuleFlags;
  catalog: ReadonlyArray<{ id: JevPointId }>;
  profilePresets: Record<Exclude<JevProfile, 'off' | 'custom'>, readonly JevPointId[]>;
  updatedAt: string;
}

export interface JevSettingsStore {
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

export interface JevChain {
  baseUrl: string;
  apiKey: string;
  model: string;
  points: readonly JevPointId[];
  /** Derived from `points` for older call sites. */
  modules: JevModuleFlags;
}

const EMPTY_POINTS: JevPoints = {
  goalGate: false,
  toolGate: false,
  compact: false,
  route: false,
  contextSelect: false,
  toolSelect: false,
  skillSelect: false,
  sagaGate: false,
  memorySelect: false,
  recoveryChoice: false,
  preTurn: false,
  ptcDecide: false
};

export function defaultJevSettings(): JevSettings {
  return {
    baseUrl: '',
    apiKey: '',
    model: 'jev-latest',
    profile: 'off',
    points: { ...EMPTY_POINTS },
    modules: { ...EMPTY_POINTS },
    enabled: false,
    armed: false,
    updatedAt: new Date(0).toISOString()
  };
}

function envApiKey(env: NodeJS.ProcessEnv): string {
  return (
    env.TYPESAFE_API_KEY ||
    env.TYPESAFE_AI_API_KEY ||
    env.JEV_API_KEY ||
    ''
  ).trim();
}

function cleanUrl(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim().replace(/\/+$/, '');
  return '';
}

function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function isProfile(raw: unknown): raw is JevProfile {
  return typeof raw === 'string' && (JEV_PROFILES as readonly string[]).includes(raw);
}

function normalizePoints(
  points: Partial<JevPoints> | null | undefined,
  modules: Partial<JevModuleFlags> | null | undefined
): JevPoints {
  const src = { ...(modules ?? {}), ...(points ?? {}) };
  return {
    goalGate: flag(src.goalGate, false),
    toolGate: flag(src.toolGate, false),
    compact: flag(src.compact, false),
    route: flag(src.route, false),
    contextSelect: flag(src.contextSelect, false),
    toolSelect: flag(src.toolSelect, false),
    skillSelect: flag(src.skillSelect, false),
    sagaGate: flag(src.sagaGate, false),
    memorySelect: flag(src.memorySelect, false),
    recoveryChoice: flag(src.recoveryChoice, false),
    preTurn: flag(src.preTurn, false),
    ptcDecide: flag(src.ptcDecide, false)
  };
}

function pointsToFlags(ids: readonly JevPointId[]): JevModuleFlags {
  const set = new Set(ids);
  return {
    goalGate: set.has('goalGate'),
    toolGate: set.has('toolGate'),
    compact: set.has('compact'),
    route: set.has('route'),
    contextSelect: set.has('contextSelect'),
    toolSelect: set.has('toolSelect'),
    skillSelect: set.has('skillSelect'),
    sagaGate: set.has('sagaGate'),
    memorySelect: set.has('memorySelect'),
    recoveryChoice: set.has('recoveryChoice'),
    preTurn: set.has('preTurn'),
    ptcDecide: set.has('ptcDecide')
  };
}

function flagsToPointList(flags: JevPoints): JevPointId[] {
  return JEV_POINT_IDS.filter((id) => flags[id]);
}

/**
 * Pure: which insertion points fire for these settings.
 * No baseUrl ⇒ always []. `off` / `mini` ⇒ [].
 * Presets ignore custom checkboxes; `custom` uses only `points`.
 */
export function activePoints(
  settings: Pick<JevSettings, 'baseUrl' | 'profile' | 'points'> & { armed?: boolean }
): JevPointId[] {
  if (settings.armed === false) return [];
  if (!settings.baseUrl) return [];
  const profile = settings.profile;
  if (profile === 'off') return [];
  if (profile === 'custom') return flagsToPointList(settings.points);
  if (profile === 'mini' || profile === 'normal' || profile === 'full' || profile === 'max') {
    return [...JEV_PROFILE_POINTS[profile]];
  }
  return [];
}

function migrateProfile(
  raw: Partial<JevSettings> & { modules?: Partial<JevModuleFlags>; points?: Partial<JevPoints> }
): { profile: JevProfile; points: JevPoints } {
  const points = normalizePoints(raw.points, raw.modules);
  if (isProfile(raw.profile)) {
    return { profile: raw.profile, points };
  }
  // Pre-profile KV: enabled + modules → custom (or off).
  if (raw.enabled === true) {
    return { profile: 'custom', points };
  }
  return { profile: 'off', points };
}

export function normalizeJevSettings(raw: Partial<JevSettings> | null | undefined): JevSettings {
  const base = defaultJevSettings();
  if (!raw || typeof raw !== 'object') return base;
  const baseUrl = cleanUrl(raw.baseUrl);
  const migrated = migrateProfile(raw);
  let profile = migrated.profile;
  const points = migrated.points;
  let armed = typeof raw.armed === 'boolean' ? raw.armed : profile !== 'off';
  if (armed && profile === 'off') profile = 'normal';
  const enabled = baseUrl.length > 0 && armed && profile !== 'off';
  return {
    baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : base.model,
    profile,
    points,
    modules: { ...points },
    enabled,
    armed,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

export function readJevSettings(store: JevSettingsStore): JevSettings {
  const saved = store.getDaemonControl?.(JEV_SETTINGS_KEY) as Partial<JevSettings> | undefined;
  if (!saved) return defaultJevSettings();
  return normalizeJevSettings(saved);
}

export function writeJevSettings(store: JevSettingsStore, patch: JevSettingsPatch): JevSettings {
  const current = readJevSettings(store);

  let profile = current.profile;
  let armed = current.armed;
  if (isProfile(patch.profile)) {
    profile = patch.profile;
    armed = profile !== 'off';
  } else if (typeof patch.enabled === 'boolean' && typeof patch.armed !== 'boolean') {
    // Legacy PATCH: enabled false → off; enabled true without profile → custom.
    profile = patch.enabled ? (profile === 'off' ? 'custom' : profile) : 'off';
    armed = profile !== 'off';
  }
  if (typeof patch.armed === 'boolean') {
    armed = patch.armed;
    if (armed && profile === 'off') profile = 'normal';
  }

  const mergedPoints = normalizePoints(
    { ...current.points, ...(patch.points ?? {}), ...(patch.modules ?? {}) },
    undefined
  );

  const next = normalizeJevSettings({
    ...current,
    ...('baseUrl' in patch ? { baseUrl: patch.baseUrl } : {}),
    ...('model' in patch ? { model: patch.model } : {}),
    profile,
    armed,
    points: mergedPoints,
    modules: mergedPoints,
    apiKey: patch.clearApiKey
      ? ''
      : typeof patch.apiKey === 'string' && patch.apiKey.trim()
        ? patch.apiKey.trim()
        : current.apiKey,
    updatedAt: new Date().toISOString()
  });
  store.setDaemonControl?.(JEV_SETTINGS_KEY, next);
  return next;
}

export function publicJevSettings(
  settings: JevSettings,
  env: NodeJS.ProcessEnv = process.env
): JevSettingsPublic {
  const configured = settings.baseUrl.length > 0;
  const active = activePoints(settings);
  const activeFlags = pointsToFlags(active);
  return {
    configured,
    baseUrl: settings.baseUrl,
    apiKeySet: Boolean(settings.apiKey) || (configured && Boolean(envApiKey(env))),
    model: settings.model,
    profile: settings.profile,
    armed: settings.armed,
    points: settings.points,
    activePoints: active,
    chained: active.length > 0,
    enabled: settings.enabled,
    modules: settings.modules,
    active: activeFlags,
    catalog: JEV_POINT_IDS.map((id) => ({ id })),
    profilePresets: { ...JEV_PROFILE_POINTS },
    updatedAt: settings.updatedAt
  };
}

/** Null unless an entry is saved and at least one insertion point is active. */
export function resolveJevChain(
  store: JevSettingsStore,
  env: NodeJS.ProcessEnv = process.env
): JevChain | null {
  const settings = readJevSettings(store);
  const points = activePoints(settings);
  if (!settings.baseUrl || points.length === 0) return null;
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey || envApiKey(env),
    model: settings.model,
    points,
    modules: pointsToFlags(points)
  };
}

export function chainHas(chain: JevChain | null | undefined, point: JevPointId): boolean {
  return Boolean(chain?.points.includes(point));
}
