'use client';

import {useState,useEffect} from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { LoadGate, SelectField, SourceBadge, StatusLine } from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';

export type SkillDisclosureMode = 'shortlist' | 'lazy' | 'full';

interface SkillSettings {
  routingMode?: SkillEffective['routingMode'];
  strictLoad?: boolean;
  fusion?: boolean;
  disclosureMode: SkillDisclosureMode;
}

interface SkillEffective {
  routingMode: 'legacy'|'lexical'|'hybrid';
  topK: number;
  strictLoad: boolean;
  fusion: boolean;
  disclosureMode: SkillDisclosureMode;
  source: string;
}

const MODES: readonly SkillDisclosureMode[] = ['shortlist', 'lazy', 'full'];
const DEFAULT_MODE: SkillDisclosureMode = 'shortlist';

export function SkillSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<SkillSettings, SkillEffective>('/api/skills/settings');
  const [topK,setTopK] = useState('8');
  useEffect(()=>{if(r.effective)setTopK(String(r.effective.topK));},[r.effective?.topK]);
  const base = 'settingsEntries.skills';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const effective = {disclosureMode: DEFAULT_MODE, ...r.settings, ...r.effective};
  const routing = {routingMode:'hybrid', strictLoad:false, fusion:false, ...r.effective, ...r.settings};
  const mode = effective.disclosureMode;
  const options = MODES.map((v) => ({ value: v, label: label(`options.disclosure.${v}.label`) }));

  return (
    <SettingsGroup id="card-skill-disclosure" title={label('title')} description={label('desc')}>
      <LoadGate ready={r.settings !== null} error={r.loadError} onRetry={() => void r.reload()}>
        <SelectField
          id="field-skillDisclosure"
          label={label('fields.disclosure.label')}
          hint={`${label('fields.disclosure.hint')} ${label(`options.disclosure.${mode}.desc`)}`}
          value={mode}
          options={options}
          disabled={r.busy}
          defaultText={label(`options.disclosure.${DEFAULT_MODE}.label`)}
          isDefault={mode === DEFAULT_MODE}
          onRestore={() => void r.save({ disclosureMode: DEFAULT_MODE })}
          onChange={(disclosureMode) => void r.save({ disclosureMode })}
        />
        <SelectField id="field-skillRouting" label={t('botSettings.routing')} value={routing.routingMode} options={(['hybrid','lexical','legacy'] as const).map(value=>({value,label:t(`botSettings.${value}`)}))} disabled={r.busy} onChange={routingMode=>void r.save({routingMode})}/>
        <form onSubmit={e=>{e.preventDefault();void r.save({topK:Number(topK)});}}><label>{t('botSettings.topK')}<input type="number" min={1} max={50} step={1} required value={topK} disabled={r.busy} onChange={e=>setTopK(e.target.value)}/></label><button className="btn btn-sm" disabled={r.busy||topK===String(r.effective?.topK)}>{t('botWork.save')}</button></form>
        <label style={{display:'block'}}><input type="checkbox" checked={routing.strictLoad} disabled={r.busy} onChange={e=>void r.save({strictLoad:e.target.checked})}/>{t('botSettings.strict')}</label>
        <label style={{display:'block'}}><input type="checkbox" checked={routing.fusion} disabled={r.busy} onChange={e=>void r.save({fusion:e.target.checked})}/>{t('botSettings.fusion')}</label>
        <p>{t('botSettings.globalHint')}</p>
        <StatusLine status={r.status} />
        {r.effective ? <SourceBadge source={r.effective.source} /> : null}
      </LoadGate>
    </SettingsGroup>
  );
}
