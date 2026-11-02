import { isUserPreferenceKey, type UserPreferences } from './user-preference-schema.ts';
export const PREFERENCES_CHANGED = 'ppeng-user-preferences-changed';
let pending: UserPreferences = {};
export function pendingPreferences(): UserPreferences { return {...pending}; }
export function acknowledgePreferences(sent: UserPreferences): void {
 for (const [key,value] of Object.entries(sent)) {
  if (pending[key] === value) delete pending[key];
 }
}
export function collectLegacyPreferences(storage: Storage): UserPreferences {
 const values: UserPreferences = {};
 for (let i=0;i<storage.length;i++) {
  const key = storage.key(i)!;
  if (isUserPreferenceKey(key)) values[key] = storage.getItem(key);
 }
 return values;
}
function write(key: string, value: string | null): void {
 if (isUserPreferenceKey(key)) pending[key] = value;
 try { cacheValue(key,value); } catch { /* Pending data survives unavailable storage. */ }
}
function cacheValue(key: string,value: string | null): void {
 if (value === null) window.localStorage.removeItem(key);
 else window.localStorage.setItem(key,value);
}
export const preferenceStorage = {
 getItem: (key: string) => window.localStorage.getItem(key),
 setItem: (key: string,value: string) => write(key,value),
 removeItem: (key: string) => write(key,null),
 key: (index: number) => window.localStorage.key(index),
 get length() { return window.localStorage.length; }
};
export function receivePreferences(values: UserPreferences): void {
 const changed = Object.entries(values).map(([key,value]) => receivePreference(key,value)).some(Boolean);
 if (changed) window.dispatchEvent(new Event(PREFERENCES_CHANGED));
}
function receivePreference(key: string,value: string | null): boolean {
 if (Object.hasOwn(pending,key)) return false;
 try {
  const oldValue = window.localStorage.getItem(key);
  if (oldValue === value) return false;
  cacheValue(key,value);
  window.dispatchEvent(new StorageEvent('storage',{key,oldValue,newValue:value}));
  return true;
 } catch { /* Cache is best effort. */ }
 return false;
}

export function scopedLegacyPreferences(storage: Storage, scope: string): UserPreferences {
 const previous = storage.getItem('lab.preferenceOwner');
 const legacy = collectLegacyPreferences(storage);
 if (previous && previous !== scope) {
  pending = {};
  for (const key of Object.keys(legacy)) storage.removeItem(key);
  storage.setItem('lab.preferenceOwner',scope);
  return {};
 }
 storage.setItem('lab.preferenceOwner',scope);
 return legacy;
}
