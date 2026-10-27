export const SKIN_IDS = ['classic', 'sanctum', 'cyberpunk', 'demon', 'robot-stage', 'pixel', 'kindergarten', 'minimal'] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export const SKIN_STORAGE_KEY = 'lab.skin';
export const SKIN_CHANGED_EVENT = 'ppeng-skin-changed';
export const SKIN_ATTRIBUTE = 'data-skin';

export function parseSkin(raw: string | null | undefined): SkinId {
  return SKIN_IDS.includes(raw as SkinId) ? (raw as SkinId) : 'classic';
}

type SkinStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type SkinRoot = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
};

export type SkinEnv = {
  storage: SkinStorage;
  root: SkinRoot;
  dispatch?: () => void;
};

function liveEnv(): SkinEnv {
  return {
    storage: window.localStorage,
    root: document.documentElement,
    dispatch: () => window.dispatchEvent(new Event(SKIN_CHANGED_EVENT))
  };
}

export function readSkin(env: SkinEnv = liveEnv()): SkinId {
  return parseSkin(env.storage.getItem(SKIN_STORAGE_KEY));
}

/** Classic removes the stored key and the attribute, so the original theme CSS applies unchanged. */
export function applySkin(skin: SkinId, env: SkinEnv = liveEnv()): void {
  if (skin === 'classic') {
    env.storage.removeItem(SKIN_STORAGE_KEY);
    env.root.removeAttribute(SKIN_ATTRIBUTE);
  } else {
    env.storage.setItem(SKIN_STORAGE_KEY, skin);
    env.root.setAttribute(SKIN_ATTRIBUTE, skin);
  }
  env.dispatch?.();
}

const styledSkins = SKIN_IDS.filter((id) => id !== 'classic');

/** Runs before first paint. Absent or unknown values leave the classic look. */
export const SKIN_BOOTSTRAP = `(()=>{try{const s=localStorage.getItem('${SKIN_STORAGE_KEY}');if(${JSON.stringify(styledSkins)}.includes(s))document.documentElement.setAttribute('${SKIN_ATTRIBUTE}',s);}catch{}})();`;
