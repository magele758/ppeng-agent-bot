/**
 * Attachment ingest + listing, and ingestion/browser Lab settings.
 */

import {
  AppError,
  errorMessage,
  hasPersistedBrowserSettings,
  hasPersistedIngestionSettings,
  hasPersistedWebSettings,
  NotFoundError,
  readBrowserSettings,
  readIngestionSettings,
  readWebSettings,
  resolveWebSearchTemplate,
  ValidationError,
  writeBrowserSettings,
  writeIngestionSettings,
  writeWebSettings,
  type BrowserSettingsPatch,
  type IngestionSettingsPatch,
  type RawAgentRuntime,
  type WebSettingsPatch
} from '@ppeng/agent-core';
import { openArtifactForDownload } from '../artifact-port.js';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { wrapSessionIdRoutes } from '../session-guard.js';

export function attachmentRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return wrapSessionIdRoutes(runtime, [
    {
      method: 'GET',
      pattern: '/api/ingestion/settings',
      handler: ({ response }) => {
        const settings = readIngestionSettings(runtime.store);
        json(response, 200, {
          settings,
          effective: {
            ...settings,
            source: hasPersistedIngestionSettings(runtime.store) ? 'ui' : 'default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/ingestion/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as IngestionSettingsPatch;
        const settings = writeIngestionSettings(runtime.store, body ?? {});
        if (body && 'libraryDirs' in body) runtime.refreshLibraryIndex();
        json(response, 200, { settings, effective: { ...settings, source: 'ui' } });
      }
    },
    {
      method: 'GET',
      pattern: '/api/browser/settings',
      handler: ({ response }) => {
        const settings = readBrowserSettings(runtime.store);
        json(response, 200, {
          settings,
          effective: {
            enabled: settings.enabled,
            source: hasPersistedBrowserSettings(runtime.store) ? 'ui' : 'env_or_default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/browser/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as BrowserSettingsPatch;
        const settings = writeBrowserSettings(runtime.store, body ?? {});
        json(response, 200, { settings, effective: { enabled: settings.enabled, source: 'ui' } });
      }
    },
    {
      method: 'GET',
      pattern: '/api/web/settings',
      handler: ({ response }) => {
        const settings = readWebSettings(runtime.store);
        const searchUrl = resolveWebSearchTemplate(runtime.store, process.env) ?? '';
        json(response, 200, {
          settings,
          effective: {
            searchUrl,
            configured: Boolean(searchUrl),
            source: hasPersistedWebSettings(runtime.store)
              ? 'ui'
              : process.env.RAW_AGENT_WEB_SEARCH_URL?.trim()
                ? 'env_or_default'
                : 'default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/web/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as WebSettingsPatch;
        const settings = writeWebSettings(runtime.store, body ?? {});
        json(response, 200, {
          settings,
          effective: {
            searchUrl: settings.searchUrl,
            configured: Boolean(settings.searchUrl),
            source: 'ui'
          }
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/attachments/ingest-base64',
      handler: async ({ requireParam, readBody, response }) => {
        const id = requireParam('id');
        const body = (await readBody()) as Record<string, unknown>;
        try {
          const result = await runtime.ingestAttachmentBase64(id, {
            dataBase64: String(body.dataBase64 ?? body.dataUrl ?? ''),
            mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
            fileName: typeof body.fileName === 'string' ? body.fileName : typeof body.filename === 'string' ? body.filename : undefined
          });
          json(response, 201, result);
        } catch (error) {
          throw error instanceof AppError ? error : new ValidationError(errorMessage(error));
        }
      }
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/attachments/fetch-url',
      handler: async ({ requireParam, readBody, response }) => {
        const id = requireParam('id');
        const body = (await readBody()) as Record<string, unknown>;
        const url = String(body.url ?? '').trim();
        if (!url) throw new ValidationError('Missing url');
        try {
          const result = await runtime.ingestAttachmentFromUrl(id, {
            url,
            fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
            mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined
          });
          json(response, 201, result);
        } catch (error) {
          throw error instanceof AppError ? error : new ValidationError(errorMessage(error));
        }
      }
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:id/attachments',
      handler: ({ requireParam, response }) => {
        const id = requireParam('id');
        if (!runtime.getSession(id)) throw new NotFoundError('Session', id);
        json(response, 200, { attachments: runtime.listSessionAttachments(id) });
      }
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:id/artifacts',
      handler: ({ requireParam, response }) => {
        const id = requireParam('id');
        if (!runtime.getSession(id)) throw new NotFoundError('Session', id);
        json(response, 200, { artifacts: runtime.listSessionArtifacts(id) });
      }
    },
    {
      method: 'GET',
      pattern: '/api/artifact/:id/download',
      handler: ({ requireParam, response }) => {
        const opened = openArtifactForDownload(runtime, requireParam('id'));
        response.statusCode = 200;
        response.setHeader('content-type', opened.mimeType);
        response.setHeader('content-disposition', `attachment; filename="${opened.fileName}"`);
        response.end(opened.bytes);
      }
    }
  ]);
}
