/**
 * Local Lab folder dialog. Authenticated admins on this machine only.
 * The handler never accepts a path to open or read.
 */

import {
  AuthorizationError,
  LAB_BROWSER_HOST_HEADER,
  pickLibraryFolder,
  libraryFolderPickAllowed,
  libraryPickBodyAllowed,
  libraryPickQueryAllowed,
  ValidationError,
  type FolderPickResult,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { headerValue } from '../user-auth.js';

export type LibraryFolderPick = typeof pickLibraryFolder;

export function libraryPickRoutes(
  _runtime: RawAgentRuntime,
  deps?: { pick?: LibraryFolderPick }
): RouteSpec[] {
  const pick = deps?.pick ?? pickLibraryFolder;
  return [
    {
      method: 'POST',
      pattern: '/api/library/pick-folder',
      handler: async ({ request, response, url, readBody }) => {
        if (
          !libraryFolderPickAllowed({
            remoteAddress: request.socket?.remoteAddress,
            forwardedHost: headerValue(request, 'x-forwarded-host'),
            browserHost: headerValue(request, LAB_BROWSER_HOST_HEADER)
          })
        ) {
          throw new AuthorizationError('local_only');
        }
        if (!libraryPickQueryAllowed(url.searchParams)) throw new ValidationError('path_not_accepted');
        const body = await readBody();
        if (!libraryPickBodyAllowed(body)) throw new ValidationError('path_not_accepted');
        const controller = new AbortController();
        const abortIfDisconnected = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.on('close', abortIfDisconnected);
        request.on('aborted', () => controller.abort());
        let result: FolderPickResult;
        try {
          result = await pick({ signal: controller.signal });
        } finally {
          response.removeListener('close', abortIfDisconnected);
        }
        if (!response.writableEnded) json(response, 200, result);
      }
    }
  ];
}
