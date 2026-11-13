'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';

function failureKey(error: unknown): MessageKey {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('obsidian_vault_required')) return 'play.obsidian.vault';
  if (code.includes('obsidian_empty')) return 'play.obsidian.empty';
  return 'play.obsidian.failed';
}

export function SaveToObsidian({id,notify}:{id:string|null;notify:(text:string,failed:boolean)=>void}) {
  const {t} = useI18n();
  const [busy,setBusy] = useState(false);
  async function save() {
    if (!id) return;
    setBusy(true);
    try {
      const note = await api('/api/sessions/'+encodeURIComponent(id)+'/obsidian',{method:'POST'}) as {vault:string;file:string};
      notify(t('play.obsidian.saved',{path:note.vault+'/'+note.file}),false);
    } catch (err) {
      notify(t(failureKey(err),{detail:String(err)}),true);
    } finally { setBusy(false); }
  }
  if (!id) return null;
  return <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={save}>{t('play.obsidian.save')}</button>;
}
