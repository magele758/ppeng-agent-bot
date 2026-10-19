/**
 * GET /api/bots/:id/materials
 * POST /api/bots/:id/materials/:materialId/reveal
 * Lists files already registered for this bot and opens that file's parent folder.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { RawAgentRuntime } from '@ppeng/agent-core';
import { json } from '../http-utils.js';
import type { RouteSpec } from '../routing.js';
import { collectBotMaterials, revealRegisteredMaterial, toPublicBotMaterial } from '../bot-materials.js';

function materialsFor(runtime: RawAgentRuntime, botId: string) {
  const bot = runtime.getBot(botId);
  const sessions = runtime.listSessions();
  const canonical = runtime.getSession(bot.canonicalSessionId);
  const all = canonical && !sessions.some((session) => session.id === canonical.id) ? [canonical, ...sessions] : sessions;
  return collectBotMaterials({
    botId: bot.id,
    canonicalSessionId: bot.canonicalSessionId,
    stateDir: runtime.stateDir,
    sessions: all.map((session) => ({ id: session.id, metadata: session.metadata ?? null })),
    artifactsForSession: (sessionId) => runtime.listSessionArtifacts(sessionId),
    fileExists: existsSync
  });
}

export function botMaterialRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/bots/:id/materials',
      handler: ({ requireParam, response }) => {
        const stored = materialsFor(runtime, requireParam('id'));
        json(response, 200, {
          materials: stored.flatMap((item) => {
            const pub = toPublicBotMaterial(item);
            return pub ? [pub] : [];
          })
        });
      }
    },
    {
      method: 'POST',
      pattern: '/api/bots/:id/materials/:materialId/reveal',
      handler: ({ requireParam, response }) => {
        const stored = materialsFor(runtime, requireParam('id'));
        try {
          revealRegisteredMaterial({
            materialId: requireParam('materialId'),
            files: stored,
            stateDir: runtime.stateDir,
            homeDir: homedir()
          });
          json(response, 200, { ok: true });
        } catch {
          json(response, 400, { error: 'reveal_rejected' });
        }
      }
    }
  ];
}
