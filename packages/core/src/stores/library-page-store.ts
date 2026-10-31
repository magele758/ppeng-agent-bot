import { DatabaseSync } from 'node:sqlite';
import { optionalString } from './storage-helpers.js';

/**
 * Library pages: durable markdown documents with a share id.
 * Distinct from `artifacts`, which index paged tool-result blobs.
 */
export interface LibraryPageRecord {
  id: string;
  title: string;
  /** Monotonic revision. Create is 1; each content or title change increments it. */
  revision: number;
  /** Opaque share token. The shareable link is `/pages/<shareId>`. */
  shareId: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryPageRevisionRecord {
  pageId: string;
  revision: number;
  title: string;
  markdown: string;
  createdAt: string;
}

export class LibraryPageStore {
  constructor(private readonly db: DatabaseSync) {}

  insertPage(row: LibraryPageRecord): LibraryPageRecord {
    this.db
      .prepare(
        `
      INSERT INTO library_pages (
        id, title, revision, share_id, markdown, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(row.id, row.title, row.revision, row.shareId, row.markdown, row.createdAt, row.updatedAt);
    return row;
  }

  updatePage(row: LibraryPageRecord): LibraryPageRecord {
    this.db
      .prepare(
        `
      UPDATE library_pages
      SET title = ?, revision = ?, markdown = ?, updated_at = ?
      WHERE id = ?
    `
      )
      .run(row.title, row.revision, row.markdown, row.updatedAt, row.id);
    return row;
  }

  rotateShareId(id: string, shareId: string): LibraryPageRecord | undefined {
    const changed = this.db
      .prepare(`UPDATE library_pages SET share_id = ? WHERE id = ?`)
      .run(shareId, id).changes;
    return changed > 0 ? this.getPage(id) : undefined;
  }

  deletePage(id: string): boolean {
    return this.db.prepare(`DELETE FROM library_pages WHERE id = ?`).run(id).changes > 0;
  }

  getPage(id: string): LibraryPageRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM library_pages WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.map(row) : undefined;
  }

  getPageByShareId(shareId: string): LibraryPageRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM library_pages WHERE share_id = ?`).get(shareId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.map(row) : undefined;
  }

  listPages(): LibraryPageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM library_pages ORDER BY updated_at DESC, id ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.map(row));
  }

  private map(row: Record<string, unknown>): LibraryPageRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      revision: Number(row.revision),
      shareId: String(row.share_id),
      markdown: optionalString(row.markdown) ?? '',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  insertRevision(row: LibraryPageRevisionRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO library_page_revisions (page_id, revision, title, markdown, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(row.pageId, row.revision, row.title, row.markdown, row.createdAt);
  }

  listRevisions(pageId: string): Array<{ revision: number; createdAt: string; title: string }> {
    const rows = this.db
      .prepare(
        `
      SELECT revision, created_at, title
      FROM library_page_revisions
      WHERE page_id = ?
      ORDER BY revision DESC
    `
      )
      .all(pageId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      title: String(row.title)
    }));
  }

  getRevision(pageId: string, revision: number): LibraryPageRevisionRecord | undefined {
    const row = this.db
      .prepare(
        `
      SELECT page_id, revision, title, markdown, created_at
      FROM library_page_revisions
      WHERE page_id = ? AND revision = ?
    `
      )
      .get(pageId, revision) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      pageId: String(row.page_id),
      revision: Number(row.revision),
      title: String(row.title),
      markdown: optionalString(row.markdown) ?? '',
      createdAt: String(row.created_at)
    };
  }

  deleteRevisionsForPage(pageId: string): void {
    this.db.prepare(`DELETE FROM library_page_revisions WHERE page_id = ?`).run(pageId);
  }
}
