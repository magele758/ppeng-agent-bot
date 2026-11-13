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

export function SaveToObsidian({id,messageIds}:{id:string;messageIds:string[]}) {
  const { t } = useI18n();
  const [busy,setBusy] = useState(false);
  const [receipt,setReceipt] = useState('');
  async function save() {
    setBusy(true);
    setReceipt('');
    try {
      const note = await api('/api/sessions/'+encodeURIComponent(id)+'/obsidian', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({messageIds})
      }) as {vault:string;file:string};
      setReceipt(t('play.obsidian.saved',{path:note.vault+'/'+note.file}));
    } catch (err) {
      setReceipt(t(failureKey(err),{detail:String(err)}));
    } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={save}
      title={t('play.obsidian.hint')}>{t('play.obsidian.save')}</button>
    <span role="status">{receipt}</span>
  </>;
}
