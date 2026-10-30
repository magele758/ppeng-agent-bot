/**
 * Sole port for library-level durable Pages.
 *
 * A Page is a markdown document with a title, a monotonic revision, and a
 * shareable id. It persists in the runtime store and is readable again after
 * the process restarts. This is not DurableArtifactPort: that port pages
 * oversized tool results by handle. Session A2UI cards stay on the message
 * they were rendered into; they are not Pages.
 */

import { randomBytes } from 'node:crypto';
import {
  A2UI_PROTOCOL_VERSION,
  type A2uiComponent,
  type A2uiMessage,
  type CreateSurfaceMessage,
  type UpdateComponentsMessage
} from '../a2ui/protocol.js';
import { BASIC_CATALOG_ID } from '../a2ui/catalog/basic.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { LibraryPageRecord } from '../stores/library-page-store.js';

export interface DurablePage {
  id: string;
  title: string;
  revision: number;
  shareId: string;
  /** Shareable path. Callers prefix their own origin. */
  sharePath: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Read-only A2UI basic-catalog surface for this revision.
   * It is not a session card: nothing here is written onto a chat message.
   */
  surface: A2uiMessage[];
}

/** Listing omits the body so a library index stays small. */
export interface DurablePageSummary {
  id: string;
  title: string;
  revision: number;
  shareId: string;
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurablePageStore {
  insertLibraryPage(row: LibraryPageRecord): LibraryPageRecord;
  updateLibraryPage(row: LibraryPageRecord): LibraryPageRecord;
  getLibraryPage(id: string): LibraryPageRecord | undefined;
  getLibraryPageByShareId(shareId: string): LibraryPageRecord | undefined;
  listLibraryPages(): LibraryPageRecord[];
}

export interface DurablePagePort {
  create(input: { title: string; markdown: string }): DurablePage;
  /** Replace title and/or markdown. Revision increments only when one of them changes. */
  update(input: { id: string; title?: string; markdown?: string }): DurablePage;
  get(id: string): DurablePage;
  /** Resolve a page from its share id. The share id is the whole capability. */
  getByShareId(shareId: string): DurablePage;
  list(): DurablePageSummary[];
}

const TITLE_MAX = 200;
const MARKDOWN_MAX = 200_000;

export function pageSharePath(shareId: string): string {
  return `/pages/${shareId}`;
}

/** Read-only basic-catalog surface. Title and body are literals, so the view cannot post back. */
export function pageSurface(row: Pick<LibraryPageRecord, 'id' | 'title' | 'markdown'>): A2uiMessage[] {
  const surfaceId = `page-${row.id}`;
  const createSurface: CreateSurfaceMessage = {
    version: A2UI_PROTOCOL_VERSION,
    createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID }
  };
  const components: A2uiComponent[] = [
    { id: 'root', component: 'Card', child: 'body' },
    { id: 'body', component: 'Column', children: ['title', 'markdown'] },
    { id: 'title', component: 'Text', text: row.title },
    { id: 'markdown', component: 'Text', text: row.markdown }
  ];
  const updateComponents: UpdateComponentsMessage = {
    version: A2UI_PROTOCOL_VERSION,
    updateComponents: { surfaceId, components }
  };
  return [createSurface, updateComponents];
}

export function toDurablePage(row: LibraryPageRecord): DurablePage {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    shareId: row.shareId,
    sharePath: pageSharePath(row.shareId),
    markdown: row.markdown,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    surface: pageSurface(row)
  };
}

export function toDurablePageSummary(page: DurablePage): DurablePageSummary {
  return {
    id: page.id,
    title: page.title,
    revision: page.revision,
    shareId: page.shareId,
    sharePath: page.sharePath,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt
  };
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${label} is required`);
  return trimmed;
}

function normalizeTitle(value: unknown): string {
  const title = requireText(value, 'title');
  if (title.length > TITLE_MAX) throw new ValidationError(`title exceeds ${TITLE_MAX} characters`);
  return title;
}

function normalizeMarkdown(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('markdown is required');
  if (value.length > MARKDOWN_MAX) throw new ValidationError(`markdown exceeds ${MARKDOWN_MAX} characters`);
  return value;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function createDurablePagePort(store: DurablePageStore, now: () => string = () => new Date().toISOString()): DurablePagePort {
  return {
    create(input) {
      const title = normalizeTitle(input.title);
      const markdown = normalizeMarkdown(input.markdown);
      const stamp = now();
      const row = store.insertLibraryPage({
        id: newId('page'),
        title,
        revision: 1,
        shareId: newId('share'),
        markdown,
        createdAt: stamp,
        updatedAt: stamp
      });
      return toDurablePage(row);
    },
    update(input) {
      const id = requireText(input.id, 'id');
      const existing = store.getLibraryPage(id);
      if (!existing) throw new NotFoundError('Page', id);
      const title = input.title === undefined ? existing.title : normalizeTitle(input.title);
      const markdown = input.markdown === undefined ? existing.markdown : normalizeMarkdown(input.markdown);
      if (title === existing.title && markdown === existing.markdown) return toDurablePage(existing);
      const row = store.updateLibraryPage({
        ...existing,
        title,
        markdown,
        revision: existing.revision + 1,
        updatedAt: now()
      });
      return toDurablePage(row);
    },
    get(id) {
      const pageId = requireText(id, 'id');
      const row = store.getLibraryPage(pageId);
      if (!row) throw new NotFoundError('Page', pageId);
      return toDurablePage(row);
    },
    getByShareId(shareId) {
      const token = requireText(shareId, 'shareId');
      const row = store.getLibraryPageByShareId(token);
      if (!row) throw new NotFoundError('Page', token);
      return toDurablePage(row);
    },
    list() {
      return store.listLibraryPages().map((row) => toDurablePageSummary(toDurablePage(row)));
    }
  };
}
