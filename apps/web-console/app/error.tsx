'use client';
import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-errors';
import { useI18n } from '@/lib/i18n';
export default function PageError({error,reset}:{error:Error;reset:()=>void}) {
 const {t}=useI18n();
 useEffect(()=>{reportClientError('next',error);},[error]);
 return <main role="alert"><h1>{t('common.clientErrorTitle')}</h1><p>{t('common.clientErrorHint')}</p>
  <button onClick={() => { if (new URL(location.href).searchParams.has('labRetry')) location.reload(); else reset(); }}>{t('common.clientErrorRetry')}</button></main>;
}
