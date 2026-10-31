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
  replaceSecureFormCardResult,
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
        const port = createSecureFormPort({ store: runtime.store, vault: runtime.userVault });

        let done: SecureFormReceipt;
        if (action === 'cancel') {
          done = port.cancel({ sessionId, id });
        } else {
          // Fill-from-Vault: vaultEntryId, entryId alias, or vaultRefs[0] opaque id.
          const vaultRefs = body.vaultRefs;
          const vaultRefId =
            Array.isArray(vaultRefs) && typeof vaultRefs[0] === 'string' ? String(vaultRefs[0]).trim() : '';
          const vaultEntryId = str(body, 'vaultEntryId') || str(body, 'entryId') || vaultRefId || '';
          if (vaultEntryId) {
            // Fill from vault entry; port resolves uvref server-side into fillRefs.
            done = port.submit({ sessionId, id, vaultEntryId });
          } else {
            // Check if multi-field values are provided
            const values = body.values;
            if (values && typeof values === 'object' && !Array.isArray(values)) {
              // Multi-field submit
              const recordValues: Record<string, string> = {};
              for (const [key, val] of Object.entries(values)) {
                if (typeof val === 'string') {
                  recordValues[key] = val;
                }
              }
              done = port.submit({ sessionId, id, values: recordValues });

              // Leak scan all submitted values AFTER submit
              for (const secret of Object.values(recordValues)) {
                if (secureFormTextLeaks(JSON.stringify(done), secret)) {
                  throw new ValidationError('refusing to return a secret in the secure form receipt');
                }
              }
            } else {
              // Single-field submit (legacy)
              const value = str(body, 'value') ?? '';
              done = port.submit({ sessionId, id, value });

              // Leak scan AFTER submit
              if (secureFormTextLeaks(JSON.stringify(done), value)) {
                throw new ValidationError('refusing to return a secret in the secure form receipt');
              }
            }
          }
        }
        const session = runtime.getSession(sessionId);
        if (session) {
          const meta: Record<string, any> = {
            id: done.id,
            status: done.status,
            text: done.text
          };

          // Set field metadata based on single or multi
          if (done.fields && done.fields.length > 0) {
            // Multi-field: use fields and fillRefs
            meta.fields = done.fields;
            const fillRefs: Array<{ field: string; fillRef?: string }> = [];
            for (const f of done.fields) {
              fillRefs.push({
                field: f.field,
                ...(f.fillRef ? { fillRef: f.fillRef } : {})
              });
            }
            meta.fillRefs = fillRefs;
          } else {
            // Single-field: use field and fillRef for backward compat
            if (done.field) meta.field = done.field;
            if (done.fillRef) meta.fillRef = done.fillRef;
          }

          runtime.mergeSessionMetadata(sessionId, {
            [SECURE_FORM_META]: meta
          });

          // The tool already wrote a pending card. Swap it for the status
          // receipt so the next turn does not keep seeing "waiting".
          replaceSecureFormCardResult(runtime.store.listMessages(sessionId), done.id, done, (messageId, parts) => {
            runtime.store.rewriteMessageParts(sessionId, messageId, parts);
          });
        }
        json(response, 200, { receipt: done });
      }
    }
  ]);
}
