'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type I18nContextValue } from '@/lib/i18n';
import { SettingsGroup } from '../../ui';
import {
  applyLibraryPick,
  errorText,
  libraryDirsFromBody,
  libraryIndexRunning,
  libraryRejectKey,
  librarySaveFailureView,
  librarySaveView,
  withoutLibraryDir,
  type LibrarySaveView
} from './library-dirs-model';
import styles from './knowledge.module.css';

function showLibrarySave(
  view: LibrarySaveView,
  t: I18nContextValue['t'],
  setDirs: (dirs: string[]) => void,
  setMsg: (msg: string | null) => void,
  setErr: (err: string | null) => void
) {
  if (view.kind === 'message') {
    setDirs(view.dirs);
    setMsg(t(view.messageKey));
    setErr(null);
    return;
  }
  setMsg(null);
  setErr(view.error === undefined ? t(view.errorKey) : t(view.errorKey, { error: view.error }));
}

async function savedLibraryDirs(): Promise<string[] | null> {
  try {
    return libraryDirsFromBody(await api('/api/ingestion/settings'));
  } catch {
    return null;
  }
}

interface IngestionSettings {
  libraryDirs?: string[];
}

export function LibraryDirsCard() {
  const { t } = useI18n();
  const [dirs, setDirs] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const data = (await api('/api/ingestion/settings')) as { settings?: IngestionSettings };
      setDirs(data.settings?.libraryDirs ?? []);
      setLoaded(true);
    } catch (e) {
      setErr(t('knowledge.library.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: string[], kind: 'saved' | 'removed') => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const data = await api('/api/ingestion/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryDirs: next })
      });
      showLibrarySave(
        librarySaveView({
          action: kind,
          previous: dirs,
          returnedDirs: libraryDirsFromBody(data),
          indexRunning: libraryIndexRunning(data)
        }),
        t,
        setDirs,
        setMsg,
        setErr
      );
    } catch (error) {
      showLibrarySave(
        librarySaveFailureView({
          action: kind,
          intended: next,
          errorMessage: errorText(error),
          loaded: await savedLibraryDirs()
        }),
        t,
        setDirs,
        setMsg,
        setErr
      );
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const data = await api('/api/library/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const applied = applyLibraryPick(dirs, data);
      switch (applied.action) {
        case 'save':
          await save(applied.dirs, 'saved');
          return;
        case 'duplicate':
          setMsg(t('knowledge.library.duplicate'));
          return;
        case 'cancelled':
          setErr(t('knowledge.library.cancelled'));
          return;
        case 'unavailable':
          setErr(t('knowledge.library.unavailable'));
          return;
        case 'rejected':
          setErr(t(libraryRejectKey(applied.reason)));
          return;
        case 'ignore':
          setErr(t('knowledge.library.pickFailed', { error: 'empty' }));
          return;
        default: {
          const never: never = applied;
          return never;
        }
      }
    } catch (e) {
      setErr(t('knowledge.library.pickFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup id="library-dirs" title={t('knowledge.library.title')} description={t('knowledge.library.desc')}>
      <div className={styles.actions}>
        <button
          id="libraryDirPick"
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || !loaded}
          onClick={() => void choose()}
        >
          {busy ? t('knowledge.library.choosing') : t('knowledge.library.choose')}
        </button>
      </div>
      {loaded && dirs.length === 0 ? <p id="libraryDirEmpty">{t('knowledge.library.empty')}</p> : null}
      {dirs.length > 0 ? (
        <ul id="libraryDirList" className={styles.dirList}>
          {dirs.map((dir) => (
            <li key={dir} className={styles.dirRow}>
              <span className={styles.dirPath}>{dir}</span>
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${styles.dirRemove}`}
                disabled={busy}
                aria-label={`${t('knowledge.library.remove')} ${dir}`}
                onClick={() => void save(withoutLibraryDir(dirs, dir), 'removed')}
              >
                {t('knowledge.library.remove')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {msg ? (
        <p role="status" className="muted">
          {msg}
        </p>
      ) : null}
      {err ? (
        <p role="alert" className={styles.error}>
          {err}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
