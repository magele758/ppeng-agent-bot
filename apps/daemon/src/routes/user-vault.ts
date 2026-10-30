/**
 * Lab User Vault (product login / card / contact entries). Distinct from /api/secrets
 * (SecretVault: connector env values). Responses carry summaries + uvref fill
 * references only; passwords, card numbers and CVV are write-only.
 */

import {
  NotFoundError,
  SECURE_FORM_META,
  ValidationError,
  createSecureFormPort,
  readUserVaultSettings,
  secureFormTextLeaks,
  writeUserVaultSettings,
  type RawAgentRuntime,
  type SecureFormReceipt,
  type UserVaultEntrySummary
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { wrapSessionIdRoutes } from '../session-guard.js';

type Body = Record<string, unknown>;

function asBody(raw: unknown): Body {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('JSON object body required');
  return raw as Body;
}

function str(body: Body, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function sites(body: Body): string[] | undefined {
  const v = body.sites;
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
}

function upsertEntry(runtime: RawAgentRuntime, body: Body): UserVaultEntrySummary {
  const vault = runtime.userVault;
  const common = { id: str(body, 'id'), label: str(body, 'label') ?? '', hint: str(body, 'hint') };
  switch (body.kind) {
    case 'login':
      return vault.upsertLogin({
        ...common,
        username: str(body, 'username'),
        sites: sites(body),
        password: str(body, 'password')
      });
    case 'card':
      return vault.upsertCard({
        ...common,
        holderName: str(body, 'holderName'),
        expiry: str(body, 'expiry'),
        billingAddressId: str(body, 'billingAddressId'),
        number: str(body, 'number'),
        cvv: str(body, 'cvv')
      });
    case 'contact':
      return vault.upsertContact({
        ...common,
        fullName: str(body, 'fullName'),
        email: str(body, 'email'),
        phone: str(body, 'phone'),
        address: str(body, 'address')
      });
    default:
      throw new ValidationError('kind must be login, card, or contact');
  }
}

export function userVaultRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/user-vault',
      handler: ({ response }) => {
        json(response, 200, {
          settings: readUserVaultSettings(runtime.store),
          entries: runtime.userVault.list()
        });
      }
    },
    {
      method: 'GET',
      pattern: '/api/user-vault/settings',
      handler: ({ response }) => json(response, 200, { settings: readUserVaultSettings(runtime.store) })
    },
    {
      method: 'PATCH',
      pattern: '/api/user-vault/settings',
      handler: async ({ readBody, response }) => {
        const body = asBody(await readBody());
        if (Object.keys(body).some((key) => key !== 'enabled')) {
          throw new ValidationError('Only enabled may be changed');
        }
        json(response, 200, { settings: writeUserVaultSettings(runtime.store, body) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/user-vault/entries',
      handler: async ({ readBody, response }) => {
        json(response, 200, { entry: upsertEntry(runtime, asBody(await readBody())) });
      }
    },
    {
      method: 'DELETE',
      pattern: '/api/user-vault/entries/:id',
      handler: ({ requireParam, response }) => {
        const id = requireParam('id');
        if (!runtime.userVault.delete(id)) throw new NotFoundError('User vault entry', id);
        json(response, 200, { ok: true, id });
      }
    },
    ...secureFormRoutes(runtime)
  ];
}

/** Chat card submit. The typed value is stored, then dropped from the response. */
function secureFormRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return wrapSessionIdRoutes(runtime, [
    {
      method: 'POST',
      pattern: '/api/sessions/:id/secure-form',
      handler: async ({ requireParam, readBody, response }) => {
        const sessionId = requireParam('id');
        const body = asBody(await readBody());
        const action = str(body, 'action') ?? 'submit';
        if (action !== 'submit' && action !== 'cancel') {
          throw new ValidationError('action must be submit or cancel');
        }
        const id = str(body, 'id') ?? '';
        const value = str(body, 'value') ?? '';
        const port = createSecureFormPort({ store: runtime.store, vault: runtime.userVault });
        const done: SecureFormReceipt =
          action === 'cancel' ? port.cancel({ sessionId, id }) : port.submit({ sessionId, id, value });
        if (secureFormTextLeaks(JSON.stringify(done), value)) {
          throw new ValidationError('refusing to return a secret in the secure form receipt');
        }
        const session = runtime.getSession(sessionId);
        if (session) {
          runtime.mergeSessionMetadata(sessionId, {
            [SECURE_FORM_META]: {
              id: done.id,
              field: done.field,
              status: done.status,
              text: done.text,
              ...(done.fillRef ? { fillRef: done.fillRef } : {})
            }
          });
        }
        json(response, 200, { receipt: done });
      }
    }
  ]);
}
