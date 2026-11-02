'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import './bot-settings-overview.css';

export function RoutineEditorDialog({ open, editingId, busy, error, onClose, children }: {
  open: boolean; editingId: string | null; busy: boolean; error: string | null;
  onClose: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return <dialog ref={ref} className="routine-editor-dialog" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h3 id={id}>{t(editingId ? 'botSettings.editRoutine' : 'botSettings.addRoutine')}</h3>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
    </header>
    {error && <p role="alert" className="bot-cron-panel__err">{error}</p>}
    {children}
  </dialog>;
}
