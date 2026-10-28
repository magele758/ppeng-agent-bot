/**
 * GET/PATCH /api/skills/settings — persist immediately in daemon_control KV.
 * Lab UI is the control plane; no new RAW_AGENT_* disclosure switch.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  ValidationError,
  hasPersistedSkillSettings,
  parseSkillDisclosureMode,
  readSkillSettings,
  resolveSkillDisclosureMode,
  resolveSkillRoutingSettings,
  writeSkillSettings,
  type SkillSettingsPatch
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function skillSettingsRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/skills/settings',
      handler: ({ response }) => {
        const settings = readSkillSettings(runtime.store);
        const disclosureMode = resolveSkillDisclosureMode({
          store: runtime.store,
          env: process.env
        });
        json(response, 200, {
          settings,
          effective: {
            disclosureMode,
            ...resolveSkillRoutingSettings({store:runtime.store,env:process.env}),
            applyAt: 'next-step',
            source: hasPersistedSkillSettings(runtime.store) ? 'ui' : 'default'
          }
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/skills/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as SkillSettingsPatch & Record<string, unknown>;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Expected a settings object');
        const patch: SkillSettingsPatch = {};
        for (const key of ['routingMode','topK','strictLoad','fusion'] as const) if (key in body) Object.assign(patch,{[key]:body[key]});
        if (body && 'disclosureMode' in body) {
          const parsed = parseSkillDisclosureMode(body.disclosureMode);
          if (!parsed) {
            throw new ValidationError('disclosureMode must be shortlist, lazy, or full');
          }
          patch.disclosureMode = parsed;
        }
        const settings = writeSkillSettings(runtime.store, patch);
        json(response, 200, {
          settings,
          effective: {
            disclosureMode: resolveSkillDisclosureMode({store:runtime.store,env:process.env}),
            ...resolveSkillRoutingSettings({store:runtime.store,env:process.env}),
            applyAt: 'next-step',
            source: 'ui' as const
          }
        });
      }
    }
  ];
}
