'use client';
import { useI18n } from '@/lib/i18n';
import { useSkillBots } from '../BotSkillSharing';
import type { SettingsResponse } from './types';
import styles from './Daydream.module.css';
export function DaydreamSettingsForm({ data, onChange, busy, onSave }: {
    data: SettingsResponse;
    onChange: (data: SettingsResponse) => void;
    busy: boolean;
    onSave: () => void;
}) {
    const { t } = useI18n();
    const { settings, policy } = data;
    const setSettings = (patch: Partial<typeof settings>) => onChange({ ...data, settings: { ...settings, ...patch } });
    return <div><label><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => setSettings({ enabled: e.target.checked })}/>{t('daydream.enabled')}</label>
 <details open><summary>{t('daydream.configure')}</summary><fieldset disabled={busy} className={styles.fields}>
 <label className={styles.field}>{t('daydream.dailyAt')}<input type="time" required value={settings.dailyAt} onChange={e => setSettings({ dailyAt: e.target.value })}/></label>
 <label className={styles.field}>{t('daydream.timezone')}<input required value={settings.timezone} onChange={e => setSettings({ timezone: e.target.value })}/></label>
 <label className={styles.field}>{t('daydream.memory')}<select value={settings.memoryPolicy} onChange={e => setSettings({ memoryPolicy: e.target.value as 'auto' | 'review' })}><option value="auto">{t('daydream.memoryAuto')}</option><option value="review">{t('daydream.memoryReview')}</option></select></label>
 <label className={styles.field}>{t('daydream.skill')}<select value={settings.skillPolicy} onChange={e => setSettings({ skillPolicy: e.target.value as 'propose' | 'autoPrivate' })}><option value="propose">{t('daydream.skillPropose')}</option><option value="autoPrivate">{t('daydream.skillAuto')}</option></select></label>
 <label><input type="checkbox" checked={settings.collaborationEnabled} onChange={e => setSettings({ collaborationEnabled: e.target.checked })}/>{t('daydream.collaboration')}</label>
 </fieldset><SharingSettings eligibleBotIds={data.eligibleBotIds} policy={policy} busy={busy} onChange={next => onChange({ ...data, policy: next })}/></details>
 <button type="button" disabled={busy} onClick={onSave}>{t('daydream.save')}</button></div>;
}
function SharingSettings({ policy, onChange, busy, eligibleBotIds }: {
    eligibleBotIds?:string[];
    policy: SettingsResponse['policy'];
    onChange: (policy: SettingsResponse['policy']) => void;
    busy: boolean;
}) {
    const { t } = useI18n();
    const allBots = useSkillBots();
    const bots = allBots.filter(bot => eligibleBotIds?.includes(bot.id) ?? true);
    const set = (patch: Partial<typeof policy>) => onChange({ ...policy, ...patch });
    const selectRecipient = (id: string, checked: boolean) => set({ sharedBotIds: checked ? [...policy.sharedBotIds, id] : policy.sharedBotIds.filter(value => value !== id) });
    return <fieldset disabled={busy} className={styles.fields}>
 <label className={styles.field}>{t('daydream.superBot')}<select aria-label={t('daydream.superBot')} value={policy.superBotId} onChange={e => set({ superBotId: e.target.value })}><option value="">{t('daydream.unassigned')}</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
 <label className={styles.field}>{t('daydream.publish')}<select value={policy.publishPolicy} onChange={e => set({ publishPolicy: e.target.value as 'review' | 'autoWithinScope' })}><option value="review">{t('daydream.publishReview')}</option><option value="autoWithinScope">{t('daydream.publishAuto')}</option></select></label>
 <fieldset className={styles.recipients}><legend>{t('daydream.recipients')}</legend>{bots.map(bot => <label key={bot.id}><input type="checkbox" checked={policy.sharedBotIds.includes(bot.id)} onChange={e => selectRecipient(bot.id, e.target.checked)}/>{bot.name}</label>)}</fieldset><p>{t('daydream.scopeHelp')}</p></fieldset>;
}
