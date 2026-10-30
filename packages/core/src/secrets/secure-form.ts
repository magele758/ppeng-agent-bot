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

export const SECURE_FORM_FIELDS = ['otp', 'password', 'cardNumber', 'cvv'] as const;

export type SecureFormField = (typeof SECURE_FORM_FIELDS)[number];

export type SecureFormStatus = 'pending' | 'filled' | 'cancelled' | 'expired';

/** What the chat card is allowed to render. No secret, no default value. */
export interface SecureFormCard {
  kind: 'secure_form';
  id: string;
  field: SecureFormField;
  label: string;
  prompt: string;
  masked: true;
  status: 'pending';
}

export interface SecureFormReceipt {
  kind: 'secure_form_receipt';
  id: string;
  field: SecureFormField;
  status: SecureFormStatus;
  /** Opaque uvref once filled. Absent until the user submits. */
  fillRef?: UserVaultFillRef;
  /** Status prose safe for model context and chat text. */
  text: string;
}

interface PendingSecureForm {
  id: string;
  sessionId: string;
  field: SecureFormField;
  label: string;
  prompt: string;
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
  cvv: 'CVV'
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

function statusText(field: SecureFormField, status: SecureFormStatus, fillRef?: string): string {
  if (status === 'filled' && fillRef) {
    return `Secure form ${field} filled. Reference ${fillRef}. Value not included.`;
  }
  if (status === 'cancelled') return `Secure form ${field} cancelled. Nothing stored.`;
  if (status === 'expired') return `Secure form ${field} expired. Nothing stored.`;
  return `Secure form ${field} is waiting for the user. Nothing stored yet.`;
}

function receipt(
  row: Pick<PendingSecureForm, 'id' | 'field'>,
  status: SecureFormStatus,
  fillRef?: UserVaultFillRef
): SecureFormReceipt {
  return {
    kind: 'secure_form_receipt',
    id: row.id,
    field: row.field,
    status,
    ...(fillRef ? { fillRef } : {}),
    text: statusText(row.field, status, fillRef)
  };
}

export interface SecureFormPort {
  /** Open one masked field. Card and receipt contain no secret. */
  request(input: {
    sessionId: string;
    field?: string;
    label?: string;
    prompt?: string;
  }): { card: SecureFormCard; receipt: SecureFormReceipt };
  /** User submit. Stores the value in UserVault; returns status only. */
  submit(input: { sessionId: string; id: string; value: string }): SecureFormReceipt;
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

  return {
    request(input) {
      const sessionId = String(input.sessionId ?? '').trim();
      if (!sessionId) throw new ValidationError('sessionId is required');
      const fieldRaw = String(input.field ?? 'otp').trim();
      if (!isField(fieldRaw)) {
        throw new ValidationError(`field must be one of: ${SECURE_FORM_FIELDS.join(', ')}`);
      }
      const label = String(input.label ?? '').trim() || FIELD_LABEL[fieldRaw];
      const prompt =
        String(input.prompt ?? '').trim() || `Enter ${label.toLowerCase()}. It stays out of the chat.`;
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

    submit(input) {
      const sessionId = String(input.sessionId ?? '').trim();
      const id = String(input.id ?? '').trim();
      const value = String(input.value ?? '');
      if (!value.trim()) throw new ValidationError('value is required');
      const row = take(sessionId, id);
      const vault = vaultOrBound(options.vault);
      const entryId = entryIdFor(row.id);
      if (row.field === 'otp' || row.field === 'password') {
        vault.upsertLogin({ id: entryId, label: row.label, password: value });
      } else if (row.field === 'cardNumber') {
        vault.upsertCard({ id: entryId, label: row.label, number: value });
      } else {
        vault.upsertCard({ id: entryId, label: row.label, cvv: value });
      }
      const fillField = row.field === 'otp' ? 'password' : row.field;
      const fillRef = makeUserVaultFillRef(entryId, fillField);
      const done = receipt(row, 'filled', fillRef);
      assertModelFacingHasNoUserVaultSecrets(JSON.stringify(done), vault);
      return done;
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
