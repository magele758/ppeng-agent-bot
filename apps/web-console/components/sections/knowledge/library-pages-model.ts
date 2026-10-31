/** Pure helpers for the Lab library Pages panel (list / open / share / rotate / delete). */

export interface LibraryPageSummary {
  id: string;
  title: string;
  revision: number;
  shareId: string;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryPageDetail extends LibraryPageSummary {
  markdown: string;
}

export function parsePageList(data: unknown): LibraryPageSummary[] {
  if (!data || typeof data !== 'object') return [];
  const pages = (data as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return [];
  const out: LibraryPageSummary[] = [];
  for (const row of pages) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.title !== 'string') continue;
    if (typeof r.sharePath !== 'string' || typeof r.shareId !== 'string') continue;
    out.push({
      id: r.id,
      title: r.title,
      revision: typeof r.revision === 'number' ? r.revision : 0,
      shareId: r.shareId,
      sharePath: r.sharePath,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : ''
    });
  }
  return out;
}

export function parsePageDetail(data: unknown): LibraryPageDetail | null {
  if (!data || typeof data !== 'object') return null;
  const page = (data as { page?: unknown }).page;
  if (!page || typeof page !== 'object') return null;
  const r = page as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  if (typeof r.sharePath !== 'string' || typeof r.shareId !== 'string') return null;
  if (typeof r.markdown !== 'string') return null;
  return {
    id: r.id,
    title: r.title,
    revision: typeof r.revision === 'number' ? r.revision : 0,
    shareId: r.shareId,
    sharePath: r.sharePath,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    markdown: r.markdown
  };
}

/** After delete, drop the id from the list without remounting callers. */
export function withoutPage(pages: LibraryPageSummary[], id: string): LibraryPageSummary[] {
  return pages.filter((p) => p.id !== id);
}

/** After rotate, replace the matching summary/detail share fields. */
export function withRotatedShare<T extends LibraryPageSummary>(
  pages: T[],
  next: Pick<LibraryPageSummary, 'id' | 'shareId' | 'sharePath'>
): T[] {
  return pages.map((p) =>
    p.id === next.id ? { ...p, shareId: next.shareId, sharePath: next.sharePath } : p
  );
}

export interface LibraryPageRevisionSummary {
  revision: number;
  createdAt: string;
  title: string;
}

export interface LibraryPageRevision {
  pageId: string;
  revision: number;
  title: string;
  markdown: string;
  createdAt: string;
}

export function parseRevisionList(raw: unknown): LibraryPageRevisionSummary[] {
  const rows = (raw as { revisions?: unknown })?.revisions;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const r = row as Record<string, unknown>;
      const revision = Number(r.revision);
      if (!Number.isFinite(revision) || revision <= 0) return null;
      return {
        revision,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
        title: typeof r.title === 'string' ? r.title : ''
      };
    })
    .filter((x): x is LibraryPageRevisionSummary => x !== null);
}

export function parseRevisionDetail(raw: unknown): LibraryPageRevision | null {
  const rev = (raw as { revision?: unknown })?.revision ?? raw;
  if (!rev || typeof rev !== 'object') return null;
  const r = rev as Record<string, unknown>;
  const revision = Number(r.revision);
  if (!Number.isFinite(revision) || revision <= 0) return null;
  if (typeof r.pageId !== 'string' || typeof r.title !== 'string') return null;
  return {
    pageId: r.pageId,
    revision,
    title: r.title,
    markdown: typeof r.markdown === 'string' ? r.markdown : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : ''
  };
}

