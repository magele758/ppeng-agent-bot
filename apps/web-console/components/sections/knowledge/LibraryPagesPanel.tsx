'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup } from '../../ui';
import {
  parsePageDetail,
  parsePageList,
  withRotatedShare,
  withoutPage,
  type LibraryPageDetail,
  type LibraryPageSummary
} from './library-pages-model';
import styles from './knowledge.module.css';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function LibraryPagesPanel() {
  const { t } = useI18n();
  const [pages, setPages] = useState<LibraryPageSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LibraryPageDetail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const data = await api('/api/library/pages');
      setPages(parsePageList(data));
      setLoaded(true);
    } catch (e) {
      setErr(t('knowledge.pages.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const data = await api(`/api/library/pages/${encodeURIComponent(id)}`);
      const page = parsePageDetail(data);
      if (!page) throw new Error('invalid page');
      setSelectedId(id);
      setDetail(page);
    } catch (e) {
      setErr(t('knowledge.pages.openFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setSelectedId(null);
    setDetail(null);
    setMsg(null);
    setErr(null);
  };

  const copyShare = async (sharePath: string) => {
    setMsg(null);
    setErr(null);
    try {
      await navigator.clipboard.writeText(sharePath);
      setMsg(t('knowledge.pages.copied'));
    } catch (e) {
      setErr(t('knowledge.pages.copyFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const rotate = async (id: string) => {
    if (!window.confirm(t('knowledge.pages.rotateConfirm'))) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const data = await api(`/api/library/pages/${encodeURIComponent(id)}/rotate-share`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: '{}'
      });
      const page = parsePageDetail(data);
      if (!page) throw new Error('invalid page');
      setPages((prev) => withRotatedShare(prev, page));
      setDetail(page);
      setMsg(t('knowledge.pages.rotated'));
    } catch (e) {
      setErr(t('knowledge.pages.rotateFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t('knowledge.pages.deleteConfirm'))) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api(`/api/library/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setPages((prev) => withoutPage(prev, id));
      setSelectedId(null);
      setDetail(null);
      setMsg(t('knowledge.pages.deleted'));
    } catch (e) {
      setErr(t('knowledge.pages.deleteFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup id="library-pages" title={t('knowledge.pages.title')} description={t('knowledge.pages.desc')}>
      <div className={styles.actions}>
        {selectedId ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={back}>
            {t('knowledge.pages.back')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !loaded}
            onClick={() => void load()}
          >
            {t('knowledge.pages.refresh')}
          </button>
        )}
      </div>

      {!loaded && !err ? <p className="muted">{t('knowledge.pages.loading')}</p> : null}

      {loaded && !selectedId && pages.length === 0 ? (
        <p id="libraryPagesEmpty">{t('knowledge.pages.empty')}</p>
      ) : null}

      {loaded && !selectedId && pages.length > 0 ? (
        <ul id="libraryPagesList" className={styles.list} data-testid="library-pages-list">
          {pages.map((row) => (
            <li key={row.id} className={styles.row}>
              <div className={styles.rowMain}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void open(row.id)}
                >
                  {row.title}
                </button>
                <span className="muted">{t('knowledge.pages.revision', { n: String(row.revision) })}</span>
              </div>
              <div className={styles.value}>{row.sharePath}</div>
              <div className={styles.actions}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void open(row.id)}>
                  {t('knowledge.pages.open')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void copyShare(row.sharePath)}
                >
                  {t('knowledge.pages.copyShare')}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void rotate(row.id)}
                >
                  {busy ? t('knowledge.pages.rotating') : t('knowledge.pages.rotate')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void remove(row.id)}
                >
                  {busy ? t('knowledge.pages.deleting') : t('knowledge.pages.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {detail && selectedId ? (
        <div id="libraryPagesDetail" data-testid="library-pages-detail" className={styles.list}>
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <strong className={styles.key}>{detail.title}</strong>
              <span className="muted">{t('knowledge.pages.revision', { n: String(detail.revision) })}</span>
            </div>
            <div className={styles.value}>
              {t('knowledge.pages.sharePath')}: {detail.sharePath}
            </div>
            {detail.updatedAt ? (
              <div className={styles.value}>{t('knowledge.pages.updatedAt', { time: detail.updatedAt })}</div>
            ) : null}
            <div className={styles.actions}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void copyShare(detail.sharePath)}
              >
                {t('knowledge.pages.copyShare')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void rotate(detail.id)}
              >
                {busy ? t('knowledge.pages.rotating') : t('knowledge.pages.rotate')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void remove(detail.id)}
              >
                {busy ? t('knowledge.pages.deleting') : t('knowledge.pages.delete')}
              </button>
            </div>
            <h4 className={styles.subhead}>{t('knowledge.pages.body')}</h4>
            <pre className={styles.pre} data-testid="library-pages-markdown">
              {detail.markdown}
            </pre>
          </div>
        </div>
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
