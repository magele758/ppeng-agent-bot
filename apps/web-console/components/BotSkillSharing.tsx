'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export type SkillBot = { id: string; name: string };
export function useSkillBots() {
  const [bots, setBots] = useState<SkillBot[]>([]);
  useEffect(() => { let alive = true; void api('/api/bots').then(data => {
    if (alive) setBots((data as { bots?: SkillBot[] }).bots ?? []);
  }).catch(() => {}); return () => { alive = false; }; }, []);
  return bots;
}
export function BotSkillSharing({ bots, owner, selected, onChange, disabled = false }: {
  bots: SkillBot[]; owner: string; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  return <fieldset disabled={disabled} className="skill-sharing-options">
    <legend>{t('skillProposals.shareWith')}</legend>
    <p>{selected.length ? t('skillProposals.readOnlyShare') : t('skillProposals.privateScope')}</p>
    {bots.filter(b => b.id !== owner).map(bot => <label key={bot.id} style={{ display: 'inline-flex', gap: 6, marginRight: 16 }}>
      <input type="checkbox" checked={selected.includes(bot.id)} onChange={e => onChange(e.target.checked ? [...selected, bot.id] : selected.filter(id => id !== bot.id))} />{bot.name}
    </label>)}
  </fieldset>;
}
