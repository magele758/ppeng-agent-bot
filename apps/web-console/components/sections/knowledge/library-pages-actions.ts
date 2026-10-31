import {
  parsePageDetail,
  parsePageList,
  withRotatedShare,
  withoutPage,
  type LibraryPageDetail,
  type LibraryPageSummary
} from './library-pages-model.ts';

export type ApiFn = (path: string, init?: RequestInit) => Promise<unknown>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadPages(api: ApiFn): Promise<{ pages: LibraryPageSummary[] } | { error: string }> {
  try {
    return { pages: parsePageList(await api('/api/library/pages')) };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function openPage(api: ApiFn, id: string): Promise<{ page: LibraryPageDetail } | { error: string }> {
  try {
    const page = parsePageDetail(await api(`/api/library/pages/${encodeURIComponent(id)}`));
    if (!page) return { error: 'invalid page' };
    return { page };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function copySharePath(
  writeText: (text: string) => Promise<void>,
  sharePath: string
): Promise<{ ok: true } | { error: string }> {
  try {
    await writeText(sharePath);
    return { ok: true };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function rotatePageShare(
  api: ApiFn,
  id: string
): Promise<{ page: LibraryPageDetail } | { error: string }> {
  try {
    const page = parsePageDetail(
      await api(`/api/library/pages/${encodeURIComponent(id)}/rotate-share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
    );
    if (!page) return { error: 'invalid page' };
    return { page };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function deletePage(api: ApiFn, id: string): Promise<{ ok: true } | { error: string }> {
  try {
    await api(`/api/library/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (e) {
    return { error: errText(e) };
  }
}

export function applyRotate(pages: LibraryPageSummary[], page: LibraryPageDetail): LibraryPageSummary[] {
  return withRotatedShare(pages, page);
}

export function applyDelete(pages: LibraryPageSummary[], id: string): LibraryPageSummary[] {
  return withoutPage(pages, id);
}
export async function createPage(api: ApiFn, title: string, markdown: string): Promise<{ page: LibraryPageDetail } | { error: string }> {
  try {
    const page = parsePageDetail(
      await api('/api/library/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, markdown })
      })
    );
    if (!page) return { error: 'invalid page response' };
    return { page };
  } catch (e) {
    return { error: errText(e) };
  }
}

export async function updatePage(api: ApiFn, id: string, updates: { title?: string; markdown?: string }): Promise<{ page: LibraryPageDetail } | { error: string }> {
  try {
    const page = parsePageDetail(
      await api(`/api/library/pages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      })
    );
    if (!page) return { error: 'invalid page response' };
    return { page };
  } catch (e) {
    return { error: errText(e) };
  }
}

export function applyCreate(pages: LibraryPageSummary[], page: LibraryPageDetail): LibraryPageSummary[] {
  const summary: LibraryPageSummary = {
    id: page.id,
    title: page.title,
    revision: page.revision,
    shareId: page.shareId,
    sharePath: page.sharePath,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt
  };
  return [summary, ...pages];
}

export function applyUpdate(pages: LibraryPageSummary[], page: LibraryPageDetail): LibraryPageSummary[] {
  return pages.map((p) =>
    p.id === page.id ? { ...p, title: page.title, revision: page.revision, updatedAt: page.updatedAt } : p
  );
}
