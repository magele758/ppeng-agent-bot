'use client';
import { useSyncExternalStore } from 'react';
import { PREFERENCES_CHANGED } from '@/lib/user-preference-storage';
let revision = 0;
function subscribe(listener: () => void) {
 const update = () => { revision++; listener(); };
 window.addEventListener(PREFERENCES_CHANGED, update);
 return () => window.removeEventListener(PREFERENCES_CHANGED,update);
}
export function usePreferenceRevision(): number {
 return useSyncExternalStore(subscribe,()=>revision,()=>0);
}
