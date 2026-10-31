'use client';

import type { LibraryPageRevision, LibraryPageRevisionSummary } from './library-pages-model.ts';

type Labels = {
  revisionsTitle: string;
  revisionsEmpty: string;
  revisionAt: (n: number, time: string) => string;
  openRevision: string;
  restoreRevision: string;
  restoringRevision: string;
};

export function PageRevisionsSection({
  revisions,
  preview,
  busy,
  onOpen,
  onRestore,
  labels
}: {
  revisions: LibraryPageRevisionSummary[];
  preview: LibraryPageRevision | null;
  busy: boolean;
  onOpen: (revision: number) => void;
  onRestore: (revision: number) => void;
  labels: Labels;
}) {
  return (
    <div data-testid="library-pages-revisions" className="stack-sm" style={{ marginTop: '0.75rem' }}>
      <h4>{labels.revisionsTitle}</h4>
      {revisions.length === 0 ? <p className="muted">{labels.revisionsEmpty}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {revisions.map((row) => (
          <li key={row.revision} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span className="muted">{labels.revisionAt(row.revision, row.createdAt)}</span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onOpen(row.revision)}>
              {labels.openRevision}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onRestore(row.revision)}>
              {busy ? labels.restoringRevision : labels.restoreRevision}
            </button>
          </li>
        ))}
      </ul>
      {preview ? (
        <pre data-testid="library-pages-revision-preview" className="muted" style={{ whiteSpace: 'pre-wrap' }}>
          {`# ${preview.title}\n\n${preview.markdown}`}
        </pre>
      ) : null}
    </div>
  );
}
