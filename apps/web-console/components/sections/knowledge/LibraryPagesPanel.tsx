'use client';

import { SettingsGroup } from '../../ui';
import type { LibraryPageDetail, LibraryPageSummary } from './library-pages-model';
import styles from './knowledge.module.css';
import { useLibraryPages } from './use-library-pages';

function PageList({
  pages,
  busy,
  onOpen,
  onCopy,
  onRotate,
  onDelete,
  labels
}: {
  pages: LibraryPageSummary[];
  busy: boolean;
  onOpen: (id: string) => void;
  onCopy: (sharePath: string) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  labels: {
    open: string;
    copyShare: string;
    rotate: string;
    rotating: string;
    delete: string;
    deleting: string;
    revision: (n: number) => string;
  };
}) {
  return (
    <ul id="libraryPagesList" className={styles.list} data-testid="library-pages-list">
      {pages.map((row) => (
        <li key={row.id} className={styles.row}>
          <div className={styles.rowMain}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onOpen(row.id)}>
              {row.title}
            </button>
            <span className="muted">{labels.revision(row.revision)}</span>
          </div>
          <div className={styles.value}>{row.sharePath}</div>
          <div className={styles.actions}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onOpen(row.id)}>
              {labels.open}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onCopy(row.sharePath)}>
              {labels.copyShare}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onRotate(row.id)}>
              {busy ? labels.rotating : labels.rotate}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDelete(row.id)}>
              {busy ? labels.deleting : labels.delete}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PageDetail({
  detail,
  busy,
  onCopy,
  onRotate,
  onDelete,
  labels
}: {
  detail: LibraryPageDetail;
  busy: boolean;
  onCopy: (sharePath: string) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  labels: {
    copyShare: string;
    rotate: string;
    rotating: string;
    delete: string;
    deleting: string;
    revision: (n: number) => string;
    sharePath: string;
    updatedAt: (time: string) => string;
    body: string;
  };
}) {
  return (
    <div id="libraryPagesDetail" data-testid="library-pages-detail" className={styles.list}>
      <div className={styles.row}>
        <div className={styles.rowMain}>
          <strong className={styles.key}>{detail.title}</strong>
          <span className="muted">{labels.revision(detail.revision)}</span>
        </div>
        <div className={styles.value}>
          {labels.sharePath}: {detail.sharePath}
        </div>
        {detail.updatedAt ? <div className={styles.value}>{labels.updatedAt(detail.updatedAt)}</div> : null}
        <div className={styles.actions}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onCopy(detail.sharePath)}>
            {labels.copyShare}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onRotate(detail.id)}>
            {busy ? labels.rotating : labels.rotate}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDelete(detail.id)}>
            {busy ? labels.deleting : labels.delete}
          </button>
        </div>
        <h4 className={styles.subhead}>{labels.body}</h4>
        <pre className={styles.pre} data-testid="library-pages-markdown">
          {detail.markdown}
        </pre>
      </div>
    </div>
  );
}

export function LibraryPagesPanel() {
  const s = useLibraryPages();
  const revision = (n: number) => s.t('knowledge.pages.revision', { n: String(n) });
  const actionLabels = {
    open: s.t('knowledge.pages.open'),
    copyShare: s.t('knowledge.pages.copyShare'),
    rotate: s.t('knowledge.pages.rotate'),
    rotating: s.t('knowledge.pages.rotating'),
    delete: s.t('knowledge.pages.delete'),
    deleting: s.t('knowledge.pages.deleting'),
    revision
  };

  return (
    <SettingsGroup id="library-pages" title={s.t('knowledge.pages.title')} description={s.t('knowledge.pages.desc')}>
      <div className={styles.actions}>
        {s.selectedId ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={s.busy} onClick={s.back}>
            {s.t('knowledge.pages.back')}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={s.busy || !s.loaded} onClick={() => void s.load()}>
            {s.t('knowledge.pages.refresh')}
          </button>
        )}
      </div>

      {!s.loaded && !s.err ? <p className="muted">{s.t('knowledge.pages.loading')}</p> : null}
      {s.loaded && !s.selectedId && s.pages.length === 0 ? <p id="libraryPagesEmpty">{s.t('knowledge.pages.empty')}</p> : null}
      {s.loaded && !s.selectedId && s.pages.length > 0 ? (
        <PageList
          pages={s.pages}
          busy={s.busy}
          onOpen={(id) => void s.open(id)}
          onCopy={(p) => void s.copyShare(p)}
          onRotate={(id) => void s.rotate(id)}
          onDelete={(id) => void s.remove(id)}
          labels={actionLabels}
        />
      ) : null}
      {s.detail && s.selectedId ? (
        <PageDetail
          detail={s.detail}
          busy={s.busy}
          onCopy={(p) => void s.copyShare(p)}
          onRotate={(id) => void s.rotate(id)}
          onDelete={(id) => void s.remove(id)}
          labels={{
            ...actionLabels,
            sharePath: s.t('knowledge.pages.sharePath'),
            updatedAt: (time) => s.t('knowledge.pages.updatedAt', { time }),
            body: s.t('knowledge.pages.body')
          }}
        />
      ) : null}

      {s.msg ? (
        <p role="status" className="muted">
          {s.msg}
        </p>
      ) : null}
      {s.err ? (
        <p role="alert" className={styles.error}>
          {s.err}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
