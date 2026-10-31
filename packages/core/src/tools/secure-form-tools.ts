/**
 * `secure_form` — chat card for a single credential field (OTP first).
 *
 * The model never supplies the secret. The tool opens a masked card and,
 * once the user has submitted, returns a fill-status receipt. Plaintext
 * stays in UserVault. This is not `vault_fill` and not SecretVault.
 */

import { ValidationError } from '../errors.js';
import {
  SECURE_FORM_FIELDS,
  SECURE_FORM_META,
  SECURE_FORM_TOOL_NAME,
  createSecureFormPort,
  type SecureFormField,
  type SecureFormPort,
  type SecureFormReceipt,
  type SecureFormStatus
} from '../secrets/secure-form.js';
import { assertModelFacingHasNoUserVaultSecrets, type UserVault, type UserVaultFillRef } from '../secrets/user-vault.js';
import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';

interface SecureFormMeta {
  id?: string;
  field?: SecureFormField;
  fields?: Array<{ field: SecureFormField; fillRef: string }>;
  status?: SecureFormStatus | 'pending';
  text?: string;
  fillRef?: string;
}

export interface SecureFormToolServices {
  /** Read/write the form id and the status receipt. Must not persist the secret. */
  readMeta: (sessionId: string) => SecureFormMeta | undefined;
  writeMeta: (sessionId: string, patch: SecureFormMeta) => void;
  port: SecureFormPort;
  /** Present so a filled receipt can be scanned for known vault secrets. */
  getVault?: () => UserVault | undefined;
}

function fail(content: string): ToolExecutionResult {
  return { ok: false, content };
}

function metaOf(context: RunContext, services: SecureFormToolServices): SecureFormMeta | undefined {
  return services.readMeta(context.session.id) ?? (context.session.metadata?.[SECURE_FORM_META] as SecureFormMeta | undefined);
}
function asReceipt(meta: SecureFormMeta | undefined): SecureFormReceipt | undefined {
  if (!meta?.id || !meta.status || !meta.text) return undefined;
  if (meta.status !== 'filled' && meta.status !== 'cancelled' && meta.status !== 'expired') return undefined;
  
  // Multi-field receipt
  if (meta.fields && meta.fields.length > 0) {
    const fields = meta.fields.map((f) => ({
      field: f.field,
      fillRef: f.fillRef as unknown as UserVaultFillRef
    }));
    return {
      kind: 'secure_form_receipt',
      id: meta.id,
      fields,
      status: meta.status,
      text: meta.text
    };
  }
  
  // Single-field receipt (backward compat)
  if (!meta.field) return undefined;
  return {
    kind: 'secure_form_receipt',
    id: meta.id,
    field: meta.field,
    status: meta.status,
    ...(meta.fillRef ? { fillRef: meta.fillRef as unknown as UserVaultFillRef } : {}),
    text: meta.text
  };
}

export function createSecureFormTool(services: SecureFormToolServices): ToolContract<{
  field?: string;
  fields?: Array<{ field: string; label?: string }>;
  label?: string;
  prompt?: string;
}> {
  return {
    name: SECURE_FORM_TOOL_NAME,
    description:
      'Ask the user to type one or more secrets (otp, password, cardNumber, cvv) into a masked chat card. You never receive the values. After they submit, the result is a fill status and opaque uvref(s) only. Not vault_fill (browser) and not connector secrets. Use fields array for multi-field (e.g., username+password). Use single field for backward compat.',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: [...SECURE_FORM_FIELDS], description: 'Single field mode (defaults to otp)' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: [...SECURE_FORM_FIELDS] },
              label: { type: 'string' }
            },
            required: ['field']
          },
          description: 'Multi-field mode (e.g., [{field: "password", label: "Username"}, {field: "password", label: "Password"}])'
        },
        label: { type: 'string', description: 'Short card title (single field only), no secret' },
        prompt: { type: 'string', description: 'What to ask the user (single field only), no secret' }
      }
    },
    approvalMode: 'always',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const done = asReceipt(metaOf(context, services));
      if (done) {
        const content = JSON.stringify(done);
        const vault = services.getVault?.();
        if (vault) assertModelFacingHasNoUserVaultSecrets(content, vault);
        return { ok: done.status === 'filled', content };
      }
      try {
        // Multi-field mode
        if (args.fields && Array.isArray(args.fields) && args.fields.length > 0) {
          const opened = services.port.request({
            sessionId: context.session.id,
            fields: args.fields
          });
          services.writeMeta(context.session.id, {
            id: opened.card.id,
            fields: opened.card.fields?.map((f) => ({ field: f.field, fillRef: '' })),
            status: 'pending'
          });
          const content = JSON.stringify({ card: opened.card, receipt: opened.receipt });
          return { ok: false, content };
        }
        
        // Single-field mode (backward compat)
        const opened = services.port.request({
          sessionId: context.session.id,
          field: args.field,
          label: args.label,
          prompt: args.prompt
        });
        services.writeMeta(context.session.id, {
          id: opened.card.id,
          field: opened.card.field,
          status: 'pending'
        });
        const content = JSON.stringify({ card: opened.card, receipt: opened.receipt });
        return { ok: false, content };
      } catch (error) {
        const message = error instanceof ValidationError ? error.message : 'Could not open a secure form';
        return fail(message);
      }
    }
  };
}

/** Bind a port onto the daemon control store and the process UserVault. */
export function secureFormPortFor(store: {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}, vault?: UserVault): SecureFormPort {
  return createSecureFormPort({ store, vault });
}
