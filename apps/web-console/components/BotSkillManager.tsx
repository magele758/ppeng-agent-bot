'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { BotSkillSharing, useSkillBots, type SkillBot } from './BotSkillSharing';
export type ManagedSkill = { id: string; name: string; ownerBotId?: string; sharedBotIds?: string[]; blockedBotIds?: string[] };
export function BotSkillManager({ skills, onChange }: { skills: ManagedSkill[]; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const bots = useSkillBots();
  const [view, setView] = useState('');
  const visible = skills.filter(s => !view || !s.ownerBotId || s.ownerBotId === view || s.sharedBotIds?.includes(view));
  return <section data-testid="bot-skill-manager">
    <h4>{t('skillProposals.approvedTitle')} ({skills.length})</h4>
    <label>{t('skillProposals.filterBot')} <select aria-label={t('skillProposals.filterBot')} value={view} onChange={e => setView(e.target.value)}>
      <option value="">{t('skillProposals.allBots')}</option>{bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select></label>
    {visible.map(s => <ManagedRow key={`${s.id}:${s.ownerBotId}:${s.sharedBotIds?.join(',')}`} skill={s} bots={bots} readOnly={!!view && !!s.ownerBotId && s.ownerBotId !== view} onChange={onChange} />)}
  </section>;
}
function ManagedRow({ skill, bots, readOnly, onChange }: { skill: ManagedSkill; bots: SkillBot[]; readOnly: boolean; onChange: () => Promise<void> }) {
  const { t } = useI18n();
  const [owner, setOwner] = useState(skill.ownerBotId ?? '');
  const [selected, setSelected] = useState(skill.sharedBotIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const name = (id: string) => bots.find(b => b.id === id)?.name ?? id;
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/skill-proposals/${encodeURIComponent(skill.id)}/sharing`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerBotId: owner, sharedBotIds: selected }) });
      await onChange(); setMessage(t('skillProposals.sharingSaved'));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function revoke() {
    const affected = skill.ownerBotId ? [skill.ownerBotId, ...(skill.sharedBotIds ?? [])].map(name).join(', ') : t('skillProposals.allBots');
    if (!window.confirm(t('skillProposals.revokeAffected', { name: skill.name, bots: affected }))) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/api/skill-proposals/${encodeURIComponent(skill.id)}/revoke`, { method: 'POST' }) as { outcome?: string };
      await onChange();
      if (result.outcome === 'foreign') setError(t('skillProposals.revokeForeignHint'));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <article className="skill-capture-card" data-testid={`skill-managed-${skill.id}`}>
    <h4>{skill.name}</h4>
    <p>{skill.ownerBotId ? t('skillProposals.ownerBot', { name: name(skill.ownerBotId) }) : t('skillProposals.legacyShared')} · {readOnly ? t('skillProposals.receivedReadOnly') : t('skillProposals.owned')}</p>
    <p>{t('skillProposals.recipients', { names: skill.ownerBotId ? (skill.sharedBotIds?.map(name).join(', ') || t('skillProposals.privateScope')) : t('skillProposals.allBots') })}</p>
    {skill.blockedBotIds?.length ? <p role="status">{t('skillProposals.sharingRestricted', { names: skill.blockedBotIds.map(name).join(', ') })}</p> : null}
    {!readOnly && <>
      {!skill.ownerBotId && <label>{t('skillProposals.chooseOwner')} <select aria-label={t('skillProposals.chooseOwner')} value={owner} disabled={busy} onChange={e => { setOwner(e.target.value); setSelected([]); }}>
        <option value="">{t('skillProposals.legacyShared')}</option>{bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select></label>}
      {owner && <BotSkillSharing bots={bots} owner={owner} selected={selected} onChange={setSelected} disabled={busy} />}
      <p className="muted">{t('skillProposals.unshareHistory')}</p>
      <button className="btn btn-primary btn-sm" disabled={busy || !owner} onClick={() => void save()}>{t('skillProposals.saveSharing')}</button>{' '}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>{t('skillProposals.revoke')}</button>
    </>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </article>;
}
