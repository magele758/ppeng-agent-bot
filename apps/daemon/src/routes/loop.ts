/**
 * Agent-loop Lab settings HTTP API.
 * GET/PATCH /api/loop/settings — persist immediately in daemon_control KV.
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import { ValidationError } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import {
  hasPersistedLoopSettings,
  loopSettingsAsRuntimeHint,
  parseInboxOverflowCap,
  parseAssemblyPreset,
  parseKernelVariant,
  parseRepeatGuardMode,
  parseSteerDrainPolicy,
  readLoopSettings,
  writeLoopSettings,
  parseSteerInterruptPolicy,
  type LoopSettingsPatch,
  type SkillScope,
  type TaskMode
} from '../loop-settings.js';

function effectivePayload(settings: ReturnType<typeof readLoopSettings>, source: 'ui' | 'default') {
  return {
    steerDrainPolicy: settings.steerDrainPolicy,
    inboxOverflowCap: settings.inboxOverflowCap,
    steerInterruptPolicy: settings.steerInterruptPolicy,
    source
  };
}

export function loopRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/loop/settings',
      handler: ({ response }) => {
        const settings = readLoopSettings(runtime.store);
        json(response, 200, {
          settings,
          runtimeHint: loopSettingsAsRuntimeHint(settings),
          effective: effectivePayload(
            settings,
            hasPersistedLoopSettings(runtime.store) ? 'ui' : 'default'
          )
        });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/loop/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as LoopSettingsPatch & Record<string, unknown>;
        const patch: LoopSettingsPatch = {};
        if (body && 'steerDrainPolicy' in body) {
          const parsed = parseSteerDrainPolicy(body.steerDrainPolicy);
          if (!parsed) {
            throw new ValidationError('steerDrainPolicy must be next_shot_only or tool_launch');
          }
          patch.steerDrainPolicy = parsed;
        }
        if (body && 'inboxOverflowCap' in body) {
          const parsed = parseInboxOverflowCap(body.inboxOverflowCap);
          if (parsed === undefined) {
            throw new ValidationError(
              'inboxOverflowCap must be a positive integer, or null/0/off for unlimited'
            );
          }
          patch.inboxOverflowCap = parsed;
        }
        if (body && 'defaultTaskMode' in body) {
          const parsed = String(body.defaultTaskMode ?? '').trim();
          const allowed: TaskMode[] = [
            'computer',
            'browser',
            'auto',
            'deep_research',
            'planner',
            'teams',
            'fast',
            'dynamic_workflow'
          ];
          if (parsed === 'standard') {
            patch.defaultTaskMode = 'auto';
          } else if (allowed.includes(parsed as TaskMode)) {
            patch.defaultTaskMode = parsed as TaskMode;
          } else {
            throw new ValidationError(
              'defaultTaskMode must be computer|browser|auto|deep_research|planner|teams|fast|dynamic_workflow'
            );
          }
        }
        if (body && 'defaultSkillScope' in body) {
          const parsed = body.defaultSkillScope;
          if (parsed !== 'full' && parsed !== 'requested') {
            throw new ValidationError('defaultSkillScope must be full or requested');
          }
          patch.defaultSkillScope = parsed as SkillScope;
        }
        if (body && 'steerInterruptPolicy' in body) {
          const parsed = parseSteerInterruptPolicy(body.steerInterruptPolicy);
          if (!parsed) {
            throw new ValidationError('steerInterruptPolicy must be queue, steer, or disabled');
          }
          patch.steerInterruptPolicy = parsed;
        }
        if (body && 'kernelVariant' in body) {
          const parsed = parseKernelVariant(body.kernelVariant);
          if (!parsed) {
            throw new ValidationError('kernelVariant must be ppeng or agent-loop');
          }
          patch.kernelVariant = parsed;
        }
        if (body && 'assemblyPreset' in body) {
          const parsed = parseAssemblyPreset(body.assemblyPreset);
          if (!parsed) {
            throw new ValidationError('assemblyPreset must be mini, normal, full, or max');
          }
          patch.assemblyPreset = parsed;
        }
        if (body && 'repeatGuard' in body) {
          const parsed = parseRepeatGuardMode(body.repeatGuard);
          if (!parsed) {
            throw new ValidationError('repeatGuard must be weak, all, or off');
          }
          patch.repeatGuard = parsed;
        }
        if (body && 'engineEnabled' in body) {
          if (typeof body.engineEnabled !== 'boolean') {
            throw new ValidationError('engineEnabled must be a boolean');
          }
          patch.engineEnabled = body.engineEnabled;
        }
        const settings = writeLoopSettings(runtime.store, patch);
        json(response, 200, {
          settings,
          runtimeHint: loopSettingsAsRuntimeHint(settings),
          effective: effectivePayload(settings, 'ui')
        });
      }
    }
  ];
}
