/**
 * Library durable Pages: create, update, get, list, and a share link.
 *
 * These are markdown documents in the library, not session A2UI cards and not
 * paged tool-result artifacts. The share path is the capability: anyone with
 * the share id can read that page, and nothing else.
 */

import {
  createDurablePagePort,
  ValidationError,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

function pagePort(runtime: RawAgentRuntime) {
  return createDurablePagePort(runtime.store);
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function libraryPageRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/library/pages',
      handler: ({ response }) => {
        json(response, 200, { pages: pagePort(runtime).list() });
      }
    },
    {
      method: 'POST',
      pattern: '/api/library/pages',
      handler: async ({ readBody, response }) => {
        const body = ((await readBody()) ?? {}) as Record<string, unknown>;
        const page = pagePort(runtime).create({
          title: readString(body, 'title') ?? '',
          markdown: readString(body, 'markdown') ?? ''
        });
        json(response, 201, { page });
      }
    },
    {
      method: 'GET',
      pattern: '/api/library/pages/:id',
      handler: ({ requireParam, response }) => {
        json(response, 200, { page: pagePort(runtime).get(requireParam('id')) });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/library/pages/:id',
      handler: async ({ requireParam, readBody, response }) => {
        const body = ((await readBody()) ?? {}) as Record<string, unknown>;
        if (!('title' in body) && !('markdown' in body)) {
          throw new ValidationError('title or markdown is required');
        }
        const page = pagePort(runtime).update({
          id: requireParam('id'),
          title: readString(body, 'title'),
          markdown: readString(body, 'markdown')
        });
        json(response, 200, { page });
      }
    },
    {
      method: 'GET',
      pattern: '/api/pages/share/:shareId',
      handler: ({ requireParam, response }) => {
        json(response, 200, { page: pagePort(runtime).getByShareId(requireParam('shareId')) });
      }
    }
  ];
}
