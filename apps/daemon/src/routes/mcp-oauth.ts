/**
 * Loopback callback for MCP OAuth 2.1.
 * The browser is not opened by the daemon. Operators open the authorization URL
 * from the connect error, and the authorization server redirects here.
 * `RAW_AGENT_AUTH_TOKEN` is enforced like every other `/api` route.
 */
import { ValidationError, finishMcpHttpOAuth, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function mcpOAuthRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/mcp/oauth/callback',
      handler: async ({ url, response }) => {
        response.setHeader('cache-control', 'no-store');
        const code = url.searchParams.get('code')?.trim() ?? '';
        const state = url.searchParams.get('state')?.trim() ?? '';
        if (!code || !state) throw new ValidationError('code and state are required');
        const result = await finishMcpHttpOAuth({
          stateDir: runtime.stateDir,
          code,
          state
        });
        json(response, 200, { ok: true, url: result.endpointUrl });
      }
    }
  ];
}
