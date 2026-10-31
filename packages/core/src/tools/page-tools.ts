/**
 * `list_pages` / `get_page` / `write_page` / `edit_page` / `rotate_page_share` / `delete_page` over DurablePagePort.
 *
 * Library markdown pages, not a canvas and not oversized tool-result pages.
 * Listing never includes the body. The share path is the port's share path
 * and stays the same across edits.
 */

import { NotFoundError, ValidationError } from '../errors.js';
import type { DurablePage, DurablePagePort, DurablePageSummary, DurablePageRevision, DurablePageRevisionSummary } from '../library/durable-page-port.js';
import type { ToolContract, ToolExecutionResult } from '../types.js';

export const PAGE_TOOL_NAMES = ['list_pages', 'get_page', 'write_page', 'edit_page', 'rotate_page_share', 'delete_page', 'list_page_revisions', 'get_page_revision', 'restore_page_revision'] as const;

export interface PageToolServices {
  getPagePort: () => DurablePagePort;
}

function fail(content: string): ToolExecutionResult {
  return { ok: false, content };
}

function okJson(value: unknown): ToolExecutionResult {
  return { ok: true, content: JSON.stringify(value, null, 2) };
}

/** Port errors the model can act on become a failed tool result; anything else still throws. */
function fromPort(error: unknown): ToolExecutionResult | undefined {
  if (error instanceof ValidationError || error instanceof NotFoundError) return fail(error.message);
  return undefined;
}

/** What list_pages is allowed to say. Body fields never leave the port through this shape. */
function summaryView(page: DurablePageSummary) {
  return {
    id: page.id,
    title: page.title,
    revision: page.revision,
    shareId: page.shareId,
    sharePath: page.sharePath
  };
}

function pageView(page: DurablePage) {
  return {
    id: page.id,
    title: page.title,
    revision: page.revision,
    shareId: page.shareId,
    sharePath: page.sharePath,
    markdown: page.markdown,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt
  };
}

function writtenView(page: DurablePage) {
  return { id: page.id, revision: page.revision, sharePath: page.sharePath };
}

function revisionSummaryView(rev: DurablePageRevisionSummary) {
  return {
    revision: rev.revision,
    createdAt: rev.createdAt,
    title: rev.title
  };
}

function revisionView(rev: DurablePageRevision) {
  return {
    pageId: rev.pageId,
    revision: rev.revision,
    title: rev.title,
    markdown: rev.markdown,
    createdAt: rev.createdAt
  };
}

export function createPageTools(services: PageToolServices): ToolContract<any>[] {
  const list: ToolContract<Record<string, never>> = {
    name: 'list_pages',
    description:
      'List durable library pages. Returns id, title, revision, shareId, and sharePath only — never the markdown body. Use get_page to read a body.',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute() {
      return okJson({ pages: services.getPagePort().list().map(summaryView) });
    }
  };

  const get: ToolContract<{ id?: string; shareId?: string }> = {
    name: 'get_page',
    description:
      'Read one durable library page, including its markdown. Pass id, or shareId from list_pages / write_page. shareId is the share-link capability and does not require the page id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page id from write_page or list_pages' },
        shareId: { type: 'string', description: 'Share id; used when id is omitted' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_ctx, args) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const shareId = typeof args.shareId === 'string' ? args.shareId.trim() : '';
      if (!id && !shareId) return fail('id or shareId is required');
      const port = services.getPagePort();
      try {
        return okJson(pageView(id ? port.get(id) : port.getByShareId(shareId)));
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  const write: ToolContract<{ title?: string; markdown?: string }> = {
    name: 'write_page',
    description:
      'Create a durable library page from a title and markdown body. Returns id, revision (1), and sharePath. An empty title is rejected and nothing is stored.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        markdown: { type: 'string', description: 'Markdown body. May be long; it is not echoed by list_pages.' }
      },
      required: ['title', 'markdown']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(_ctx, args) {
      try {
        return okJson(writtenView(services.getPagePort().create({ title: String(args.title ?? ''), markdown: String(args.markdown ?? '') })));
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  const edit: ToolContract<{ id?: string; title?: string; markdown?: string }> = {
    name: 'edit_page',
    description:
      'Update a durable library page by id. Pass title and/or markdown; omitted fields stay as they are. Revision increments only when something changes. sharePath stays the same.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string' }
      },
      required: ['id']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(_ctx, args) {
      const patch: { id: string; title?: string; markdown?: string } = {
        id: typeof args.id === 'string' ? args.id : ''
      };
      if (typeof args.title === 'string') patch.title = args.title;
      if (typeof args.markdown === 'string') patch.markdown = args.markdown;
      try {
        const page = services.getPagePort().update(patch);
        return okJson({ ...writtenView(page), title: page.title, shareId: page.shareId });
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  const rotate: ToolContract<{ id?: string }> = {
    name: 'rotate_page_share',
    description:
      'Rotate a durable library page share link by id. The old share link is revoked and a new shareId/sharePath is returned. Page title, markdown, revision, and content timestamps stay unchanged.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Page id from write_page or list_pages' } },
      required: ['id']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(_ctx, args) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      try {
        const page = services.getPagePort().rotateShare(id);
        return okJson({ id: page.id, revision: page.revision, shareId: page.shareId, sharePath: page.sharePath });
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  const remove: ToolContract<{ id?: string }> = {
    name: 'delete_page',
    description:
      'Permanently delete a durable library page by id and revoke its share link. Missing ids fail without changing other pages.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Page id from write_page or list_pages' } },
      required: ['id']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(_ctx, args) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      try {
        services.getPagePort().delete(id);
        return okJson({ deleted: true, id });
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };


  const listRevisions: ToolContract<{ id?: string }> = {
    name: 'list_page_revisions',
    description:
      'List revision history for a durable library page by id. Returns revision number, createdAt timestamp, and title for each archived revision. Older revisions can be restored.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Page id from write_page or list_pages' } },
      required: ['id']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_ctx, args) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      try {
        return okJson({ revisions: services.getPagePort().listRevisions(id).map(revisionSummaryView) });
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  const getRevision: ToolContract<{ id?: string; revision?: number }> = {
    name: 'get_page_revision',
    description:
      'Read a specific revision of a durable library page, including its full title and markdown body. Use list_page_revisions to see available revisions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page id' },
        revision: { type: 'number', description: 'Revision number to read' }
      },
      required: ['id', 'revision']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_ctx, args) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const revision = typeof args.revision === 'number' ? args.revision : 0;
      if (!id) return fail('id is required');
      if (revision <= 0) return fail('revision must be a positive number');
      try {
        return okJson(revisionView(services.getPagePort().getRevision(id, revision)));
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  const restoreRevision: ToolContract<{ id?: string; revision?: number }> = {
    name: 'restore_page_revision',
    description:
      'Restore an older revision of a durable library page. This loads the archived title and markdown from the specified revision and applies it as a new update, incrementing the revision number. Use list_page_revisions to find available revisions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page id' },
        revision: { type: 'number', description: 'Revision number to restore' }
      },
      required: ['id', 'revision']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(_ctx, args) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const revision = typeof args.revision === 'number' ? args.revision : 0;
      if (!id) return fail('id is required');
      if (revision <= 0) return fail('revision must be a positive number');
      try {
        const page = services.getPagePort().restoreRevision(id, revision);
        return okJson({ ...writtenView(page), title: page.title, restored: true });
      } catch (error) {
        const result = fromPort(error);
        if (result) return result;
        throw error;
      }
    }
  };

  return [list, get, write, edit, rotate, remove, listRevisions, getRevision, restoreRevision];
}
