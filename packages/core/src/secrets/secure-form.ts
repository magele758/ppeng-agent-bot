/**
 * Secure Form: in-chat single-field credential fill (OTP first).
 *
 * Not `vault_fill` (browser session) and not SecretVault (connector env).
 * The model asks for one masked field. The user types into the chat card.
 * The value is stored only inside UserVault. Model text, chat text, and the
 * tool receipt report fill status — never the secret.
 */

import { ValidationError } from '../errors.js';
import { createId } from '../id.js';
import {
  assertModelFacingHasNoUserVaultSecrets,
  getBoundUserVault,
  makeUserVaultFillRef,
  type UserVault,
  type UserVaultFillRef
} from './user-vault.js';

export const SECURE_FORM_TOOL_NAME = 'secure_form';

/** Session metadata key. Holds the form id only — never the typed secret. */
export const SECURE_FORM_META = 'secureForm';

export const SECURE_FORM_FIELDS = ['otp', 'password', 'cardNumber', 'cvv', 'username'] as const;

export type SecureFormField = (typeof SECURE_FORM_FIELDS)[number];

export type SecureFormStatus = 'pending' | 'filled' | 'cancelled' | 'expired';

/** Single field or multi-field input specification. */
export interface SecureFormFieldSpec {
  field: SecureFormField;
  label?: string;
}

/** What the chat card is allowed to render. No secret, no default value. */
export interface SecureFormCard {
  kind: 'secure_form';
  id: string;
  /** Single field (backward compat). */
  field?: SecureFormField;
  /** Single field label (backward compat). */
  label?: string;
  /** Single field prompt (backward compat). */
  prompt?: string;
  /** Multiple fields (new). Each with field+label, no defaults/secrets. */
  fields?: Array<{ field: SecureFormField; label: string }>;
  masked: true;
  status: 'pending';
}

/** Per-field entry in a multi-field receipt. */
export interface SecureFormReceiptField {
  field: SecureFormField;
  fillRef: UserVaultFillRef;
}

export interface SecureFormReceipt {
  kind: 'secure_form_receipt';
  id: string;
  /** Single field (backward compat). */
  field?: SecureFormField;
  /** Multi-field entries (new). */
  fields?: SecureFormReceiptField[];
  status: SecureFormStatus;
  /** Opaque uvref once filled (single-field only). Absent until the user submits. */
  fillRef?: UserVaultFillRef;
  /** Status prose safe for model context and chat text. */
  text: string;
}


interface PendingSecureForm {
  id: string;
  sessionId: string;
  /** Single field (backward compat). */
  field?: SecureFormField;
  /** Multi-field spec (new). */
  fields?: Array<{ field: SecureFormField; label: string }>;
  label?: string;
  prompt?: string;
}

interface SecureFormStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

const PENDING_KEY = 'secure_form_pending';

const FIELD_LABEL: Record<SecureFormField, string> = {
  otp: 'One-time code',
  password: 'Password',
  cardNumber: 'Card number',
  cvv: 'CVV',
  username: 'Username'
};

function isField(value: string): value is SecureFormField {
  return (SECURE_FORM_FIELDS as readonly string[]).includes(value);
}

function pendingMap(store: SecureFormStore): Record<string, PendingSecureForm> {
  const saved = store.getDaemonControl<Record<string, PendingSecureForm>>(PENDING_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  return saved;
}

function writePending(store: SecureFormStore, rows: Record<string, PendingSecureForm>): void {
  store.setDaemonControl(PENDING_KEY, rows);
}

function entryIdFor(formId: string): string {
  return `sf_${formId.replace(/[^a-zA-Z0-9_]/g, '')}`;
}

function statusText(
  row: Pick<PendingSecureForm, 'field' | 'fields'>,
  status: SecureFormStatus,
  fillRef?: UserVaultFillRef,
  fillRefs?: SecureFormReceiptField[]
): string {
  if (status === 'filled') {
    if (fillRefs && fillRefs.length > 0) {
      const refs = fillRefs.map((f) => f.fillRef).join(', ');
      return `Secure form filled with ${fillRefs.length} field(s). References: ${refs}. Values not included.`;
    }
    if (fillRef) {
      const field = row.field ?? 'field';
      return `Secure form ${field} filled. Reference ${fillRef}. Value not included.`;
    }
  }
  if (status === 'cancelled') {
    const fieldDesc = row.fields ? `${row.fields.length} field(s)` : row.field ?? 'field';
    return `Secure form ${fieldDesc} cancelled. Nothing stored.`;
  }
  if (status === 'expired') {
    const fieldDesc = row.fields ? `${row.fields.length} field(s)` : row.field ?? 'field';
    return `Secure form ${fieldDesc} expired. Nothing stored.`;
  }
  const fieldDesc = row.fields ? `${row.fields.length} field(s)` : row.field ?? 'field';
  return `Secure form ${fieldDesc} is waiting for the user. Nothing stored yet.`;
}

function receipt(
  row: Pick<PendingSecureForm, 'id' | 'field' | 'fields'>,
  status: SecureFormStatus,
  fillRef?: UserVaultFillRef,
  fillRefs?: SecureFormReceiptField[]
): SecureFormReceipt {
  return {
    kind: 'secure_form_receipt',
    id: row.id,
    ...(row.field ? { field: row.field } : {}),
    ...(fillRefs ? { fields: fillRefs } : {}),
    status,
    ...(fillRef ? { fillRef } : {}),
    text: statusText(row, status, fillRef, fillRefs)
  };
}

export interface SecureFormPort {
  /** Open one masked field (single) or multiple fields (multi). Card and receipt contain no secret. */
  request(
    input:
      | {
          sessionId: string;
          field?: string;
          label?: string;
          prompt?: string;
        }
      | {
          sessionId: string;
          fields: Array<{ field: string; label?: string }>;
        }
  ): { card: SecureFormCard; receipt: SecureFormReceipt };
  /** User submit. Stores the value(s) in UserVault; returns status only. */
  submit(
    input:
      | { sessionId: string; id: string; value: string }
      | { sessionId: string; id: string; values: Record<string, string> }
  ): SecureFormReceipt;
  /** User dismissed the card. Stores nothing. */
  cancel(input: { sessionId: string; id: string }): SecureFormReceipt;
  /** Drop a pending card when its approval is rejected. */
  expire(input: { sessionId: string; id: string }): SecureFormReceipt;
  get(id: string): PendingSecureForm | undefined;
}
export interface SecureFormPortOptions {
  store: SecureFormStore;
  /** Defaults to the process-bound UserVault. */
  vault?: UserVault;
}

function vaultOrBound(explicit: UserVault | undefined): UserVault {
  const vault = explicit ?? getBoundUserVault();
  if (!vault) throw new ValidationError('User Vault is not available for Secure Form');
  return vault;
}

export function createSecureFormPort(options: SecureFormPortOptions): SecureFormPort {
  const store = options.store;

  function take(sessionId: string, id: string): PendingSecureForm {
    const rows = pendingMap(store);
    const row = rows[id];
    if (!row || row.sessionId !== sessionId) {
      throw new ValidationError('Secure form is not waiting in this chat');
    }
    delete rows[id];
    writePending(store, rows);
    return row;
  }

  function submitMultiField(
    row: PendingSecureForm,
    input: Record<string, unknown>,
    vault: UserVault
  ): SecureFormReceipt {
    if (!row.fields || row.fields.length === 0) {
      throw new ValidationError('Multi-field submit requires fields in the pending form');
    }
    const values = 'values' in input && typeof input.values === 'object' && input.values ? (input.values as Record<string, unknown>) : {};
    const fillRefs: SecureFormReceiptField[] = [];
    const fieldsArray = row.fields;

    for (let idx = 0; idx < fieldsArray.length; idx++) {
      const spec = fieldsArray[idx];
      if (!spec) continue; // Guard against undefined
      const fieldValue = String(values[spec.field] ?? '').trim();
      if (!fieldValue) {
        throw new ValidationError(`value for field ${spec.field} is required`);
      }
      // Create unique entry ID for each field using form id + field index
      const entryId = `${entryIdFor(row.id)}_f${idx}`;
      if (spec.field === 'otp' || spec.field === 'password') {
        vault.upsertLogin({ id: entryId, label: spec.label, password: fieldValue });
      } else if (spec.field === 'username') {
        vault.upsertLogin({ id: entryId, label: spec.label, username: fieldValue });
      } else if (spec.field === 'cardNumber') {
        vault.upsertCard({ id: entryId, label: spec.label, number: fieldValue });
      } else if (spec.field === 'cvv') {
        vault.upsertCard({ id: entryId, label: spec.label, cvv: fieldValue });
      }
      const fillField = spec.field === 'otp' ? 'password' : spec.field;
      const fillRef = makeUserVaultFillRef(entryId, fillField);
      fillRefs.push({ field: spec.field, fillRef });
    }

    const done = receipt(row, 'filled', undefined, fillRefs);
    assertModelFacingHasNoUserVaultSecrets(JSON.stringify(done), vault);
    return done;
  }

  function submitSingleField(
    row: PendingSecureForm,
    input: Record<string, unknown>,
    vault: UserVault
  ): SecureFormReceipt {
    const value = String('value' in input ? input.value : '').trim();
    if (!value) throw new ValidationError('value is required');
    if (!row.field) {
      throw new ValidationError('Single-field submit requires a field in the pending form');
    }

    const entryId = entryIdFor(row.id);
    if (row.field === 'otp' || row.field === 'password') {
      vault.upsertLogin({ id: entryId, label: row.label ?? '', password: value });
    } else if (row.field === 'username') {
      vault.upsertLogin({ id: entryId, label: row.label ?? '', username: value });
    } else if (row.field === 'cardNumber') {
      vault.upsertCard({ id: entryId, label: row.label ?? '', number: value });
    } else if (row.field === 'cvv') {
      vault.upsertCard({ id: entryId, label: row.label ?? '', cvv: value });
    }
    const fillField = row.field === 'otp' ? 'password' : row.field;
    const fillRef = makeUserVaultFillRef(entryId, fillField);
    const done = receipt(row, 'filled', fillRef);
    assertModelFacingHasNoUserVaultSecrets(JSON.stringify(done), vault);
    return done;
  }
  return {
    request(input: unknown) {
      if (!input || typeof input !== 'object') {
        throw new ValidationError('request input must be an object');
      }
      const sessionId = String('sessionId' in input ? input.sessionId : '').trim();
      if (!sessionId) throw new ValidationError('sessionId is required');

      // Multi-field mode
      if ('fields' in input && Array.isArray(input.fields)) {
        if (input.fields.length === 0) {
          throw new ValidationError('fields array must not be empty');
        }
        const fieldSpecs: Array<{ field: SecureFormField; label: string }> = [];
        for (const spec of input.fields) {
          if (!spec || typeof spec !== 'object') {
            throw new ValidationError('each field spec must be an object');
          }
          const fieldRaw = String('field' in spec ? spec.field : '').trim();
          if (!isField(fieldRaw)) {
            throw new ValidationError(`field must be one of: ${SECURE_FORM_FIELDS.join(', ')}`);
          }
          const label = String('label' in spec ? spec.label : '').trim() || FIELD_LABEL[fieldRaw];
          fieldSpecs.push({ field: fieldRaw, label });
        }
        if (fieldSpecs.length === 0) {
          throw new ValidationError('fields array must not be empty');
        }

        const id = createId('sform');
        const row: PendingSecureForm = { id, sessionId, fields: fieldSpecs };
        const rows = pendingMap(store);
        rows[id] = row;
        writePending(store, rows);

        const card: SecureFormCard = {
          kind: 'secure_form',
          id,
          fields: fieldSpecs,
          masked: true,
          status: 'pending'
        };
        return { card, receipt: receipt(row, 'pending') };
      }

      // Single-field mode (backward compat)
      const fieldRaw = String('field' in input ? input.field ?? 'otp' : 'otp').trim();
      if (!isField(fieldRaw)) {
        throw new ValidationError(`field must be one of: ${SECURE_FORM_FIELDS.join(', ')}`);
      }
      const label = String('label' in input ? input.label : '').trim() || FIELD_LABEL[fieldRaw];
      const prompt =
        String('prompt' in input ? input.prompt : '').trim() || `Enter ${label.toLowerCase()}. It stays out of the chat.`;
      const id = createId('sform');
      const row: PendingSecureForm = { id, sessionId, field: fieldRaw, label, prompt };
      const rows = pendingMap(store);
      rows[id] = row;
      writePending(store, rows);
      const card: SecureFormCard = {
        kind: 'secure_form',
        id,
        field: fieldRaw,
        label,
        prompt,
        masked: true,
        status: 'pending'
      };
      return { card, receipt: receipt(row, 'pending') };
    },


    submit(input: unknown) {
      if (!input || typeof input !== 'object') {
        throw new ValidationError('submit input must be an object');
      }
      const sessionId = String('sessionId' in input ? input.sessionId : '').trim();
      const id = String('id' in input ? input.id : '').trim();
      const row = take(sessionId, id);
      const vault = vaultOrBound(options.vault);

      // Multi-field submit
      if ('values' in input && row.fields && row.fields.length > 0) {
        return submitMultiField(row, input as Record<string, unknown>, vault);
      }
      // Single-field submit (backward compat)
      return submitSingleField(row, input as Record<string, unknown>, vault);
    },

    cancel(input) {
      const row = take(String(input.sessionId ?? '').trim(), String(input.id ?? '').trim());
      return receipt(row, 'cancelled');
    },

    expire(input) {
      const row = take(String(input.sessionId ?? '').trim(), String(input.id ?? '').trim());
      return receipt(row, 'expired');
    },

    get(id) {
      return pendingMap(store)[id];
    }
  };
}

/** True when model-facing text would leak a just-stored secret. */
export function secureFormTextLeaks(text: string, secret: string): boolean {
  const body = String(text ?? '');
  const value = String(secret ?? '');
  return value.length >= 3 && body.includes(value);
}

interface SecureFormToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;
}

interface SecureFormTranscriptMessage {
  id: string;
  role: string;
  parts: readonly unknown[];
}

/**
 * The tool returns a pending card before the user types. Once they submit,
 * that same tool result must become the status receipt — otherwise the next
 * turn still shows "waiting" and never learns the fill status.
 * Returns how many messages changed. Never writes the secret.
 */
export function replaceSecureFormCardResult(
  messages: SecureFormTranscriptMessage[],
  formId: string,
  receipt: SecureFormReceipt,
  rewrite: (messageId: string, parts: SecureFormToolResultPart[]) => void
): number {
  const next = JSON.stringify(receipt);
  let changed = 0;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    let touched = false;
    const parts = message.parts.map((raw) => {
      const part = raw as Partial<SecureFormToolResultPart>;
      if (part.type !== 'tool_result' || part.name !== SECURE_FORM_TOOL_NAME) return raw as SecureFormToolResultPart;
      if (!String(part.content ?? '').includes(formId)) return raw as SecureFormToolResultPart;
      touched = true;
      return { ...(raw as SecureFormToolResultPart), ok: receipt.status === 'filled', content: next };
    });
    if (!touched) continue;
    rewrite(message.id, parts);
    changed += 1;
  }
  return changed;
}
