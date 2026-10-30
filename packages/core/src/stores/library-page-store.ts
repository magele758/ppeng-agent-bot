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
}
