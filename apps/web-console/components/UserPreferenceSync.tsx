'use client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { createPreferenceSync } from '@/lib/user-preference-sync';
import { acknowledgePreferences, scopedLegacyPreferences, pendingPreferences, receivePreferences } from '@/lib/user-preference-storage';
import { currentTheme, THEME_CHANGED_EVENT } from '@/lib/theme';
import { readSkin, SKIN_CHANGED_EVENT } from '@/lib/skin';
import { normalizeFontSize } from '@/lib/font-size';
import { SESSION_BRIEF_CHANGED_EVENT } from '@/lib/session-brief';

function applyAppearance(): void {
 const root = document.documentElement;
 root.setAttribute('data-theme',currentTheme());
 root.setAttribute('data-skin',readSkin());
 root.setAttribute('data-font-size',String(normalizeFontSize(localStorage.getItem('lab.fontSize'))));
 for (const event of [THEME_CHANGED_EVENT,SKIN_CHANGED_EVENT,SESSION_BRIEF_CHANGED_EVENT]) window.dispatchEvent(new Event(event));
}
export function UserPreferenceSync() {
 useEffect(() => {
  const sync = createPreferenceSync(api);
  let busy = false;
  let initialized = false;
  let stopped = false;
  const poll = async () => {
   if (busy) return;
   busy = true;

   try {
    let snapshot = await api('/api/user/preferences') as {scope:string;values:Record<string,string|null>};
    if (!initialized) {
     snapshot = {...snapshot,values:await sync.migrate(legacyForScope(snapshot.scope))};
     initialized = true;
    }
    const sent = pendingPreferences();
    const values = await savePending(sync,sent,snapshot.values);
    if (stopped) return;
    acknowledgePreferences(sent);
    receivePreferences(values);
    applyAppearance();
   } catch { /* Retry pending writes and migration on reconnect. */ }
   finally { busy = false; }
  };
  void poll();
  const timer = window.setInterval(() => void poll(),3000);
  return () => { stopped=true; window.clearInterval(timer); };
 },[]);
 return null;
}

function legacyForScope(scope: string) {
 try { return scopedLegacyPreferences(window.localStorage,scope); }
 catch { return {}; }
}

async function savePending(sync: ReturnType<typeof createPreferenceSync>, sent: Record<string,string|null>, current: Record<string,string|null>) {
 return Object.keys(sent).length ? sync.save(sent) : current;
}
