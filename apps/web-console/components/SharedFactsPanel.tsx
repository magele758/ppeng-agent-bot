'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { BotEntryDialog } from './BotEntryDialog';
import styles from './BotFunctionalGroups.module.css';

export function SharedFactsPanel({ open, busy, onOpen, onClose, children }: {
  open: boolean; busy: boolean; onOpen: () => void; onClose: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  return <>
    <button type="button" className={styles.sharedEntry} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
      <span>{t('play.functionalGroups.sharedTitle')}</span><span aria-hidden="true">›</span>
    </button>
    {open ? <SharedFactsOverlay label={t('play.functionalGroups.sharedTitle')}>
      <h2 className={styles.sharedHeading}>{t('play.functionalGroups.sharedTitle')}</h2>
      <div className={styles.sharedBody}>{children}</div>
      <footer className={styles.sharedFooter}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>{t('common.close')}</button>
      </footer>
    </SharedFactsOverlay> : null}
  </>;
}

function SharedFactsOverlay({ label, children }: { label: string; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(document.body); }, []);
  if (!host) return null;
  return createPortal(<BotEntryDialog label={label}>{children}</BotEntryDialog>, host);
}
