'use client';
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { installErrorListeners, reportClientError } from '@/lib/client-errors';
import { useI18n } from '@/lib/i18n';

function ErrorFallback() {
 const { t } = useI18n();
 return <main role="alert" style={{padding:32}}>
  <h1>{t('common.clientErrorTitle')}</h1>
  <p>{t('common.clientErrorHint')}</p>
  <button type="button" onClick={()=>window.location.reload()}>{t('common.clientErrorReload')}</button>
 </main>;
}
export class ClientErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
 state = {failed:false};
 static getDerivedStateFromError() { return {failed:true}; }
 componentDidCatch(error: Error, info: ErrorInfo) { reportClientError('react',error,info.componentStack ?? ''); }
 render() { return this.state.failed ? <ErrorFallback/> : this.props.children; }
}
export function ClientDiagnostics() {
 useEffect(()=>installErrorListeners(window,reportClientError),[]);
 return null;
}
