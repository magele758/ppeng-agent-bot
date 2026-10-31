/**
 * Lab admin routes for registered machines: list live, register, unregister, refresh.
 * No Factory SSH UI. Uses RegisteredMachinePort over composite backend.
 */

import {
  createRegisteredMachinePort,
  createCompositeRegisteredMachineBackend,
  getSharedDesktopAgentHub,
  getSharedDeviceLocalHub,
  resolveBotPrincipal,
  ValidationError,
  NotFoundError,
  type RawAgentRuntime,
  type RegisteredMachineKind
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

function machinePort(runtime: RawAgentRuntime) {
  return createRegisteredMachinePort(
    runtime.store,
    createCompositeRegisteredMachineBackend({
      agentHub: getSharedDesktopAgentHub(),
      deviceLocalHub: getSharedDeviceLocalHub()
    })
  );
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

export function registeredMachinesRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/registered-machines',
      handler: async ({ response, auth }) => {
        const principal = resolveBotPrincipal(
          runtime.store,
          auth.user ? { userId: auth.user.id, tenantId: auth.user.tenantId } : undefined
        );
        const machines = await machinePort(runtime).listLive(principal);
        json(response, 200, { machines });
      }
    },
    {
      method: 'POST',
      pattern: '/api/registered-machines',
      handler: async ({ readBody, response, auth }) => {
        const principal = resolveBotPrincipal(
          runtime.store,
          auth.user ? { userId: auth.user.id, tenantId: auth.user.tenantId } : undefined
        );
        const body = ((await readBody()) ?? {}) as Record<string, unknown>;

        const machineId = readString(body, 'machineId');
        const label = readString(body, 'label');
        const kind = readString(body, 'kind');

        if (!machineId || !label || !kind) {
          throw new ValidationError('machineId, label, and kind are required');
        }

        try {
          const machine = machinePort(runtime).register(principal, {
            machineId,
            label,
            kind: kind as RegisteredMachineKind
          });
          json(response, 201, { machine });
        } catch (e) {
          if (e instanceof ValidationError) {
            json(response, 400, { error: e.message });
          } else {
            throw e;
          }
        }
      }
    },
    {
      method: 'DELETE',
      pattern: '/api/registered-machines/:machineId',
      handler: ({ requireParam, response, auth }) => {
        const principal = resolveBotPrincipal(
          runtime.store,
          auth.user ? { userId: auth.user.id, tenantId: auth.user.tenantId } : undefined
        );
        const machineId = requireParam('machineId');
        const ok = machinePort(runtime).unregister(principal, machineId);
        if (!ok) {
          json(response, 404, { error: 'machine_not_found', id: machineId });
        } else {
          json(response, 200, { ok: true, id: machineId });
        }
      }
    },
    {
      method: 'POST',
      pattern: '/api/registered-machines/:machineId/refresh',
      handler: async ({ requireParam, response, auth }) => {
        const principal = resolveBotPrincipal(
          runtime.store,
          auth.user ? { userId: auth.user.id, tenantId: auth.user.tenantId } : undefined
        );
        const machineId = requireParam('machineId');
        try {
          const machine = await machinePort(runtime).refresh(principal, machineId);
          json(response, 200, { machine });
        } catch (e) {
          if (e instanceof NotFoundError) {
            json(response, 404, { error: 'machine_not_found', id: machineId });
          } else {
            throw e;
          }
        }
      }
    }
  ];
}
