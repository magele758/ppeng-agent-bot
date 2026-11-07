'use client';
import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-errors';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { useI18n } from '@/lib/i18n';
function Recovery() {
 const {t}=useI18n();
 return <main role="alert"><h1>{t('common.clientErrorTitle')}</h1><p>{t('common.clientErrorHint')}</p>
  <button onClick={()=>window.location.reload()}>{t('common.clientErrorReload')}</button></main>;
}
export default function GlobalError({error}:{error:Error}) {
 useEffect(()=>{reportClientError('next-global',error);},[error]);
 return <html><body><I18nProvider><Recovery/></I18nProvider></body></html>;
}
