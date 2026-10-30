/**
 * UserVault: product entries (login / card / contact) with fill-by-reference.
 *
 * Distinct from SecretVault (connector/env injection). Password and card
 * numbers/CVV never appear in list summaries or model-facing fill reports —
 * only opaque `uvref:…` tokens. Raw values resolve only inside fill-by-ref
 * callbacks for computerUse/forms.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createId, nowIso } from '../id.js';
import { ValidationError } from '../errors.js';

export const USER_VAULT_KEY = 'user_vault';

/** Opaque fill token; never substitute with the secret in model text. */
export const USER_VAULT_REF_PREFIX = 'uvref:';

export type UserVaultEntryKind = 'login' | 'card' | 'contact';

/** Fields that resolve to secrets and must stay off the model surface. */
export type UserVaultSecretField = 'password' | 'cardNumber' | 'cvv';

export type UserVaultFillField =
  | UserVaultSecretField
  | 'username'
  | 'holderName'
  | 'expiry'
  | 'email'
  | 'phone'
  | 'address'
  | 'fullName';

export type UserVaultFillRef = `${typeof USER_VAULT_REF_PREFIX}${string}:${UserVaultFillField}`;

export interface UserVaultStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

interface LoginRecord {
  kind: 'login';
  id: string;
  label: string;
  hint?: string;
  username?: string;
  sites?: string[];
  passwordEnc?: EncryptedBlob;
  updatedAt: string;
}

interface CardRecord {
  kind: 'card';
  id: string;
  label: string;
  hint?: string;
  holderName?: string;
  expiry?: string;
  last4?: string;
  billingAddressId?: string;
  numberEnc?: EncryptedBlob;
  cvvEnc?: EncryptedBlob;
  updatedAt: string;
}

interface ContactRecord {
  kind: 'contact';
  id: string;
  label: string;
  hint?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  address?: string;
  updatedAt: string;
}

type UserVaultRecord = LoginRecord | CardRecord | ContactRecord;

export interface UserVaultPersist {
  keyHex: string;
  entries: UserVaultRecord[];
}

export interface UserVaultEntrySummary {
  id: string;
  kind: UserVaultEntryKind;
  label: string;
  hint?: string;
  /** Opaque fill references for secret (and typed) fields — never raw secrets. */
  fillRefs: Partial<Record<UserVaultFillField, UserVaultFillRef>>;
  login?: { username?: string; sites?: string[] };
  card?: { holderName?: string; expiry?: string; last4?: string; billingAddressId?: string };
  /** Contact details are non-secret product data; list may include them. */
  contact?: { fullName?: string; email?: string; phone?: string; address?: string };
  updatedAt: string;
}

export interface FillByRefModelReport {
  filled: number;
  refs: UserVaultFillRef[];
  /** Safe for model/tool result text — contains refs only, never secret values. */
  text: string;
}

function deriveKey(keyHex: string): Buffer {
  return Buffer.from(keyHex, 'hex');
}

function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex')
  };
}

function decrypt(key: Buffer, row: EncryptedBlob): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(row.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(row.data, 'hex')), decipher.final()]).toString(
    'utf8'
  );
}

function isSecretField(field: string): field is UserVaultSecretField {
  return field === 'password' || field === 'cardNumber' || field === 'cvv';
}

export function makeUserVaultFillRef(id: string, field: UserVaultFillField): UserVaultFillRef {
  return `${USER_VAULT_REF_PREFIX}${id}:${field}`;
}

export function parseUserVaultFillRef(
  ref: string
): { id: string; field: UserVaultFillField } | undefined {
  const raw = String(ref ?? '').trim();
  if (!raw.startsWith(USER_VAULT_REF_PREFIX)) return undefined;
  const body = raw.slice(USER_VAULT_REF_PREFIX.length);
  const colon = body.lastIndexOf(':');
  if (colon <= 0) return undefined;
  const id = body.slice(0, colon);
  const field = body.slice(colon + 1) as UserVaultFillField;
  if (!id || !field) return undefined;
  return { id, field };
}

function resolveContactField(row: ContactRecord, field: UserVaultFillField): string | undefined {
  switch (field) {
    case 'fullName':
      return row.fullName;
    case 'email':
      return row.email;
    case 'phone':
      return row.phone;
    case 'address':
      return row.address;
    default:
      return undefined;
  }
}

let boundUserVault: UserVault | undefined;

export function bindUserVault(vault: UserVault | undefined): void {
  boundUserVault = vault;
}

export function getBoundUserVault(): UserVault | undefined {
  return boundUserVault;
}

export class UserVault {
  private memory = new Map<string, UserVaultRecord>();
  private persist: UserVaultPersist | undefined;

  constructor(private readonly store?: UserVaultStore) {
    if (store) this.load();
  }

  private load(): void {
    if (!this.store) return;
    const saved = this.store.getDaemonControl<UserVaultPersist>(USER_VAULT_KEY);
    if (!saved || !saved.keyHex || !Array.isArray(saved.entries)) {
      this.persist = { keyHex: randomBytes(32).toString('hex'), entries: [] };
      this.store.setDaemonControl(USER_VAULT_KEY, this.persist);
      return;
    }
    this.persist = saved;
    this.memory.clear();
    for (const row of saved.entries) {
      if (row && typeof row.id === 'string' && row.kind) this.memory.set(row.id, row);
    }
  }

  private flush(): void {
    if (!this.store) return;
    if (!this.persist) {
      this.persist = { keyHex: randomBytes(32).toString('hex'), entries: [] };
    }
    this.persist = { keyHex: this.persist.keyHex, entries: [...this.memory.values()] };
    this.store.setDaemonControl(USER_VAULT_KEY, this.persist);
  }

  private key(): Buffer {
    if (!this.persist) {
      this.persist = { keyHex: randomBytes(32).toString('hex'), entries: [] };
    }
    return deriveKey(this.persist.keyHex);
  }

  upsertLogin(input: {
    id?: string;
    label: string;
    hint?: string;
    username?: string;
    sites?: string[];
    password?: string;
  }): UserVaultEntrySummary {
    const label = String(input.label ?? '').trim();
    if (!label) throw new ValidationError('login label is required');
    const id = input.id?.trim() || createId('login');
    const existing = this.memory.get(id);
    if (existing && existing.kind !== 'login') {
      throw new ValidationError('entry id belongs to a different kind');
    }
    const prev = existing?.kind === 'login' ? existing : undefined;
    const passwordEnc =
      input.password != null && input.password !== ''
        ? encrypt(this.key(), input.password)
        : prev?.passwordEnc;
    const row: LoginRecord = {
      kind: 'login',
      id,
      label,
      hint: input.hint?.trim() || prev?.hint,
      username: input.username ?? prev?.username,
      sites: input.sites ?? prev?.sites,
      passwordEnc,
      updatedAt: nowIso()
    };
    this.memory.set(id, row);
    this.flush();
    return this.toSummary(row);
  }

  upsertCard(input: {
    id?: string;
    label: string;
    hint?: string;
    holderName?: string;
    expiry?: string;
    billingAddressId?: string;
    number?: string;
    cvv?: string;
  }): UserVaultEntrySummary {
    const label = String(input.label ?? '').trim();
    if (!label) throw new ValidationError('card label is required');
    const id = input.id?.trim() || createId('card');
    const existing = this.memory.get(id);
    if (existing && existing.kind !== 'card') {
      throw new ValidationError('entry id belongs to a different kind');
    }
    const prev = existing?.kind === 'card' ? existing : undefined;
    const digits = input.number?.replace(/\D/g, '');
    const numberEnc =
      input.number != null && input.number !== ''
        ? encrypt(this.key(), input.number)
        : prev?.numberEnc;
    const cvvEnc =
      input.cvv != null && input.cvv !== '' ? encrypt(this.key(), input.cvv) : prev?.cvvEnc;
    const last4 =
      digits && digits.length >= 4 ? digits.slice(-4) : prev?.last4;
    const row: CardRecord = {
      kind: 'card',
      id,
      label,
      hint: input.hint?.trim() || prev?.hint,
      holderName: input.holderName ?? prev?.holderName,
      expiry: input.expiry ?? prev?.expiry,
      last4,
      billingAddressId: input.billingAddressId ?? prev?.billingAddressId,
      numberEnc,
      cvvEnc,
      updatedAt: nowIso()
    };
    this.memory.set(id, row);
    this.flush();
    return this.toSummary(row);
  }

  upsertContact(input: {
    id?: string;
    label: string;
    hint?: string;
    fullName?: string;
    email?: string;
    phone?: string;
    address?: string;
  }): UserVaultEntrySummary {
    const label = String(input.label ?? '').trim();
    if (!label) throw new ValidationError('contact label is required');
    const id = input.id?.trim() || createId('contact');
    const existing = this.memory.get(id);
    if (existing && existing.kind !== 'contact') {
      throw new ValidationError('entry id belongs to a different kind');
    }
    const prev = existing?.kind === 'contact' ? existing : undefined;
    const row: ContactRecord = {
      kind: 'contact',
      id,
      label,
      hint: input.hint?.trim() || prev?.hint,
      fullName: input.fullName ?? prev?.fullName,
      email: input.email ?? prev?.email,
      phone: input.phone ?? prev?.phone,
      address: input.address ?? prev?.address,
      updatedAt: nowIso()
    };
    this.memory.set(id, row);
    this.flush();
    return this.toSummary(row);
  }

  list(): UserVaultEntrySummary[] {
    return [...this.memory.values()]
      .map((row) => this.toSummary(row))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  getSummary(id: string): UserVaultEntrySummary | undefined {
    const row = this.memory.get(id);
    return row ? this.toSummary(row) : undefined;
  }

  delete(id: string): boolean {
    const ok = this.memory.delete(id);
    if (ok) this.flush();
    return ok;
  }

  /**
   * Resolve one fill reference to a plaintext value for computerUse/forms.
   * Callers must not place the return value into model-facing messages.
   */
  resolveFillReference(ref: string): string | undefined {
    const parsed = parseUserVaultFillRef(ref);
    if (!parsed) return undefined;
    const row = this.memory.get(parsed.id);
    if (!row) return undefined;
    return this.resolveRowField(row, parsed.field);
  }

  private decryptOrUndefined(blob: EncryptedBlob | undefined): string | undefined {
    if (!blob) return undefined;
    try {
      return decrypt(this.key(), blob);
    } catch {
      return undefined;
    }
  }

  private resolveRowField(row: UserVaultRecord, field: UserVaultFillField): string | undefined {
    switch (row.kind) {
      case 'login':
        return this.resolveLoginField(row, field);
      case 'card':
        return this.resolveCardField(row, field);
      case 'contact':
        return resolveContactField(row, field);
      default: {
        const unreachable: never = row;
        return unreachable;
      }
    }
  }

  private resolveLoginField(row: LoginRecord, field: UserVaultFillField): string | undefined {
    switch (field) {
      case 'username':
        return row.username;
      case 'password':
        return this.decryptOrUndefined(row.passwordEnc);
      default:
        return undefined;
    }
  }

  private resolveCardField(row: CardRecord, field: UserVaultFillField): string | undefined {
    switch (field) {
      case 'holderName':
        return row.holderName;
      case 'expiry':
        return row.expiry;
      case 'cardNumber':
        return this.decryptOrUndefined(row.numberEnc);
      case 'cvv':
        return this.decryptOrUndefined(row.cvvEnc);
      default:
        return undefined;
    }
  }

  /** Collect every known secret plaintext (for leak tests / redaction). */
  knownSecretValues(): string[] {
    const out: string[] = [];
    for (const row of this.memory.values()) {
      if (row.kind === 'login' && row.passwordEnc) {
        try {
          out.push(decrypt(this.key(), row.passwordEnc));
        } catch {
          /* skip */
        }
      }
      if (row.kind === 'card') {
        if (row.numberEnc) {
          try {
            out.push(decrypt(this.key(), row.numberEnc));
          } catch {
            /* skip */
          }
        }
        if (row.cvvEnc) {
          try {
            out.push(decrypt(this.key(), row.cvvEnc));
          } catch {
            /* skip */
          }
        }
      }
    }
    return out.filter((v) => v.length > 0);
  }

  private toSummary(row: UserVaultRecord): UserVaultEntrySummary {
    const fillRefs: UserVaultEntrySummary['fillRefs'] = {};
    if (row.kind === 'login') {
      if (row.username) fillRefs.username = makeUserVaultFillRef(row.id, 'username');
      if (row.passwordEnc) fillRefs.password = makeUserVaultFillRef(row.id, 'password');
      return {
        id: row.id,
        kind: 'login',
        label: row.label,
        hint: row.hint,
        fillRefs,
        login: { username: row.username, sites: row.sites },
        updatedAt: row.updatedAt
      };
    }
    if (row.kind === 'card') {
      if (row.holderName) fillRefs.holderName = makeUserVaultFillRef(row.id, 'holderName');
      if (row.expiry) fillRefs.expiry = makeUserVaultFillRef(row.id, 'expiry');
      if (row.numberEnc) fillRefs.cardNumber = makeUserVaultFillRef(row.id, 'cardNumber');
      if (row.cvvEnc) fillRefs.cvv = makeUserVaultFillRef(row.id, 'cvv');
      return {
        id: row.id,
        kind: 'card',
        label: row.label,
        hint: row.hint,
        fillRefs,
        card: {
          holderName: row.holderName,
          expiry: row.expiry,
          last4: row.last4,
          billingAddressId: row.billingAddressId
        },
        updatedAt: row.updatedAt
      };
    }
    if (row.fullName) fillRefs.fullName = makeUserVaultFillRef(row.id, 'fullName');
    if (row.email) fillRefs.email = makeUserVaultFillRef(row.id, 'email');
    if (row.phone) fillRefs.phone = makeUserVaultFillRef(row.id, 'phone');
    if (row.address) fillRefs.address = makeUserVaultFillRef(row.id, 'address');
    return {
      id: row.id,
      kind: 'contact',
      label: row.label,
      hint: row.hint,
      fillRefs,
      contact: {
        fullName: row.fullName,
        email: row.email,
        phone: row.phone,
        address: row.address
      },
      updatedAt: row.updatedAt
    };
  }
}

export function createMemoryUserVault(): UserVault {
  return new UserVault();
}

/**
 * Fill-by-reference path for computerUse/forms.
 * Resolves refs → plaintext only inside `fill`; the returned model report
 * never includes secret values (password / card number / CVV).
 */
export async function fillByReferences<T>(
  vault: UserVault,
  refs: string[],
  fill: (resolved: Record<string, string>) => T | Promise<T>
): Promise<{ ok: true; result: T; modelReport: FillByRefModelReport } | { ok: false; error: string }> {
  const unique = [...new Set(refs.map((r) => String(r ?? '').trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: false, error: 'no fill references provided' };
  const resolved: Record<string, string> = {};
  const usedRefs: UserVaultFillRef[] = [];
  for (const ref of unique) {
    const parsed = parseUserVaultFillRef(ref);
    if (!parsed) return { ok: false, error: `invalid fill reference: ${ref}` };
    const value = vault.resolveFillReference(ref);
    if (value == null || value === '') {
      return { ok: false, error: `fill reference not found: ${ref}` };
    }
    resolved[ref] = value;
    usedRefs.push(ref as UserVaultFillRef);
  }
  const result = await fill(resolved);
  const modelReport: FillByRefModelReport = {
    filled: usedRefs.length,
    refs: usedRefs,
    text: `Filled ${usedRefs.length} field(s) by vault reference (${usedRefs.join(', ')}).`
  };
  // Defense in depth: never let a secret slip into the model report text.
  // Refs are opaque ids (random hex) that can contain a short secret such as a CVV by chance;
  // mask them so only the surrounding prose is scanned.
  const scanned = maskFillRefs(modelReport.text, usedRefs);
  const anySecret = usedRefs.some((r) => {
    const field = parseUserVaultFillRef(r)?.field;
    return field && isSecretField(field);
  });
  for (const value of Object.values(resolved)) {
    if (anySecret && value && scanned.includes(value)) {
      return { ok: false, error: 'refusing to emit secret value into model-facing fill report' };
    }
  }
  assertModelFacingHasNoUserVaultSecrets(scanned, vault);
  return { ok: true, result, modelReport };
}

function maskFillRefs(text: string, refs: string[]): string {
  return refs.reduce((out, ref) => out.split(ref).join('<ref>'), text);
}

/**
 * Opaque tokens that legitimately appear in model-facing vault text and can
 * contain a short secret (a CVV) by chance: entry ids, `uvref:` tokens, and
 * ISO timestamps. Masked only for the leak scan — callers still return the
 * original text, and a secret outside these tokens still fails the scan.
 */
function maskOpaqueVaultTokens(text: string): string {
  return text
    .replace(/"(?:id|billingAddressId)"\s*:\s*"[^"]*"/g, '"id":"<id>"')
    .replace(/uvref:[A-Za-z0-9_-]+:[A-Za-z]+/g, '<ref>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
}

/** Throw if model-facing text contains any known user-vault secret. */
export function assertModelFacingHasNoUserVaultSecrets(text: string, vault: UserVault): void {
  const body = maskOpaqueVaultTokens(String(text ?? ''));
  for (const secret of vault.knownSecretValues()) {
    if (secret.length >= 3 && body.includes(secret)) {
      throw new ValidationError('user vault secret must not appear in model-facing text');
    }
  }
}

/** True when a string looks like a user-vault fill ref (safe for prompts). */
export function isUserVaultFillRef(value: string): boolean {
  return parseUserVaultFillRef(value) != null;
}
