'use client';
import {useI18n} from '@/lib/i18n';
import {SettingsGroup} from './ui';
import {LoadGate,StatusLine} from './sections/settings/categories/kit/fields';
import {useSettingsResource} from './sections/settings/categories/kit/settings-store';
export function RuntimeCapabilitiesCard(){
 const {t}=useI18n();
 const r=useSettingsResource<{a2uiEnabled:boolean;domains:string[]},{availableDomains:{id:string;label:string}[]}>('/api/runtime-capabilities');
 return <SettingsGroup title={t('botSettings.runtimeTitle')} id="card-runtime-capabilities" description={t('botSettings.globalHint')}>
  <LoadGate ready={!!r.settings} error={r.loadError} onRetry={()=>void r.reload()}>
   <label><input type="checkbox" checked={r.settings?.a2uiEnabled??false} disabled={r.busy} onChange={e=>void r.save({a2uiEnabled:e.target.checked})}/>{t('botSettings.a2ui')}</label>
   <fieldset><legend>{t('botSettings.domains')}</legend>{r.effective?.availableDomains.map(d=><label key={d.id} style={{display:'block'}}><input type="checkbox" checked={r.settings?.domains.includes(d.id)??false} disabled={r.busy} onChange={e=>void r.save({domains:e.target.checked?[...(r.settings?.domains??[]),d.id]:(r.settings?.domains??[]).filter(id=>id!==d.id)})}/>{d.label}</label>)}</fieldset>
   <StatusLine status={r.status}/>
  </LoadGate>
 </SettingsGroup>;
}
