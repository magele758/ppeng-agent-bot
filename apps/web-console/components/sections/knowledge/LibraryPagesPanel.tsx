'use client';

import { SettingsGroup } from '../../ui';
import type { LibraryPageDetail, LibraryPageSummary } from './library-pages-model';
import styles from './knowledge.module.css';
import { useLibraryPages } from './use-library-pages';

type ActionLabels = {
  open: string;
  copyShare: string;
  rotate: string;
  rotating: string;
  delete: string;
  deleting: string;
  revision: (n: number) => string;
};

type Translate = (key: string, vars?: Record<string, string | number>) => string;

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
  labels: ActionLabels;
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
  labels: ActionLabels & {
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

function LibraryPagesToolbar({
  selectedId,
  busy,
  loaded,
  onBack,
  onRefresh,
  t
}: {
  selectedId: string | null;
  busy: boolean;
  loaded: boolean;
  onBack: () => void;
  onRefresh: () => void;
  t: Translate;
}) {
  if (selectedId) {
    return (
      <div className={styles.actions}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onBack}>
          {t('knowledge.pages.back')}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.actions}>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !loaded} onClick={onRefresh}>
        {t('knowledge.pages.refresh')}
      </button>
    </div>
  );
}

function LibraryPagesLoading({ loaded, err, t }: { loaded: boolean; err: string | null; t: Translate }) {
  if (loaded || err) return null;
  return <p className="muted">{t('knowledge.pages.loading')}</p>;
}

function LibraryPagesEmpty({
  loaded,
  selectedId,
  pageCount,
  t
}: {
  loaded: boolean;
  selectedId: string | null;
  pageCount: number;
  t: Translate;
}) {
  if (!loaded || selectedId || pageCount > 0) return null;
  return <p id="libraryPagesEmpty">{t('knowledge.pages.empty')}</p>;
}

function LibraryPagesListSection({
  loaded,
  selectedId,
  pages,
  busy,
  onOpen,
  onCopy,
  onRotate,
  onDelete,
  labels
}: {
  loaded: boolean;
  selectedId: string | null;
  pages: LibraryPageSummary[];
  busy: boolean;
  onOpen: (id: string) => void;
  onCopy: (sharePath: string) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  labels: ActionLabels;
}) {
  if (!loaded || selectedId || pages.length === 0) return null;
  return (
    <PageList
      pages={pages}
      busy={busy}
      onOpen={onOpen}
      onCopy={onCopy}
      onRotate={onRotate}
      onDelete={onDelete}
      labels={labels}
    />
  );
}

function LibraryPagesDetailSection({
  detail,
  selectedId,
  busy,
  onCopy,
  onRotate,
  onDelete,
  labels
}: {
  detail: LibraryPageDetail | null;
  selectedId: string | null;
  busy: boolean;
  onCopy: (sharePath: string) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  labels: ActionLabels & {
    sharePath: string;
    updatedAt: (time: string) => string;
    body: string;
  };
}) {
  if (!detail || !selectedId) return null;
  return (
    <PageDetail
      detail={detail}
      busy={busy}
      onCopy={onCopy}
      onRotate={onRotate}
      onDelete={onDelete}
      labels={labels}
    />
  );
}

function LibraryPagesMessage({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="status" className="muted">
      {msg}
    </p>
  );
}

function LibraryPagesError({ err }: { err: string | null }) {
  if (!err) return null;
  return (
    <p role="alert" className={styles.error}>
      {err}
    </p>
  );
}

export function LibraryPagesPanel() {
  const s = useLibraryPages();
  const revision = (n: number) => s.t('knowledge.pages.revision', { n: String(n) });
  const actionLabels: ActionLabels = {
    open: s.t('knowledge.pages.open'),
    copyShare: s.t('knowledge.pages.copyShare'),
    rotate: s.t('knowledge.pages.rotate'),
    rotating: s.t('knowledge.pages.rotating'),
    delete: s.t('knowledge.pages.delete'),
    deleting: s.t('knowledge.pages.deleting'),
    revision
  };
  const detailLabels = {
    ...actionLabels,
    sharePath: s.t('knowledge.pages.sharePath'),
    updatedAt: (time: string) => s.t('knowledge.pages.updatedAt', { time }),
    body: s.t('knowledge.pages.body')
  };

  return (
    <SettingsGroup id="library-pages" title={s.t('knowledge.pages.title')} description={s.t('knowledge.pages.desc')}>
      <LibraryPagesToolbar
        selectedId={s.selectedId}
        busy={s.busy}
        loaded={s.loaded}
        onBack={s.back}
        onRefresh={() => void s.load()}
        t={s.t}
      />
      <LibraryPagesLoading loaded={s.loaded} err={s.err} t={s.t} />
      <LibraryPagesEmpty loaded={s.loaded} selectedId={s.selectedId} pageCount={s.pages.length} t={s.t} />
      <LibraryPagesListSection
        loaded={s.loaded}
        selectedId={s.selectedId}
        pages={s.pages}
        busy={s.busy}
        onOpen={(id) => void s.open(id)}
        onCopy={(p) => void s.copyShare(p)}
        onRotate={(id) => void s.rotate(id)}
        onDelete={(id) => void s.remove(id)}
        labels={actionLabels}
      />
      <LibraryPagesDetailSection
        detail={s.detail}
        selectedId={s.selectedId}
        busy={s.busy}
        onCopy={(p) => void s.copyShare(p)}
        onRotate={(id) => void s.rotate(id)}
        onDelete={(id) => void s.remove(id)}
        labels={detailLabels}
      />
      <LibraryPagesMessage msg={s.msg} />
      <LibraryPagesError err={s.err} />
    </SettingsGroup>
  );
}
