import {
  parsePageDetail,
  parsePageList,
  withRotatedShare,
  withoutPage,
  type LibraryPageDetail,
  type LibraryPageSummary
} from './library-pages-model';

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
