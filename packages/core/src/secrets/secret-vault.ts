/**
 * SecretVault: Lab stores values by name; clients only reference names.
 * Exec env receives only the requested names. Skills never see values.
 * Persisted in daemon_control KV (not git). No feature-switch env.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { nowIso } from '../id.js';
import { ValidationError } from '../errors.js';
import {
  assertWritableEnvName,
  isReservedEnvName,
  stripReservedEnvNames
} from './reserved-env-names.js';

export const SECRET_VAULT_KEY = 'secret_vault';
export const SECRET_REFS_METADATA_KEY = 'secretRefs';

export interface SecretVaultStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export interface SecretEntrySummary {
  name: string;
  updatedAt: string;
}

export interface SecretVaultPersist {
  keyHex: string;
  entries: Array<{ name: string; iv: string; tag: string; data: string; updatedAt: string }>;
}

interface SecretAls {
  values: Record<string, string>;
}

const als = new AsyncLocalStorage<SecretAls>();

let boundVault: SecretVault | undefined;

export function bindSecretVault(vault: SecretVault | undefined): void {
  boundVault = vault;
}

export function getBoundSecretVault(): SecretVault | undefined {
  return boundVault;
}

function deriveKey(keyHex: string): Buffer {
  return Buffer.from(keyHex, 'hex');
}

function encrypt(key: Buffer, plaintext: string): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex')
  };
}

function decrypt(key: Buffer, row: { iv: string; tag: string; data: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(row.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(row.data, 'hex')), decipher.final()]).toString(
    'utf8'
  );
}

export class SecretVault {
  private memory = new Map<string, { value: string; updatedAt: string }>();
  private persist: SecretVaultPersist | undefined;

  constructor(private readonly store?: SecretVaultStore) {
    if (store) this.load();
  }

  private load(): void {
    if (!this.store) return;
    const saved = this.store.getDaemonControl<SecretVaultPersist>(SECRET_VAULT_KEY);
    if (!saved || !saved.keyHex || !Array.isArray(saved.entries)) {
      this.persist = { keyHex: randomBytes(32).toString('hex'), entries: [] };
      this.store.setDaemonControl(SECRET_VAULT_KEY, this.persist);
      return;
    }
    this.persist = saved;
    const key = deriveKey(saved.keyHex);
    this.memory.clear();
    for (const row of saved.entries) {
      try {
        const value = decrypt(key, row);
        this.memory.set(row.name, { value, updatedAt: row.updatedAt });
      } catch {
        /* skip corrupt */
      }
    }
  }

  private flush(): void {
    if (!this.store) return;
    if (!this.persist) {
      this.persist = { keyHex: randomBytes(32).toString('hex'), entries: [] };
    }
    const key = deriveKey(this.persist.keyHex);
    const entries = [...this.memory.entries()].map(([name, v]) => ({
      name,
      ...encrypt(key, v.value),
      updatedAt: v.updatedAt
    }));
    this.persist = { keyHex: this.persist.keyHex, entries };
    this.store.setDaemonControl(SECRET_VAULT_KEY, this.persist);
  }

  set(name: string, value: string): void {
    assertWritableEnvName(name);
    if (!value) throw new ValidationError('secret value is required');
    this.memory.set(name, { value, updatedAt: nowIso() });
    this.flush();
  }

  /** Exec-only. Never expose via Lab list. */
  get(name: string): string | undefined {
    return this.memory.get(name)?.value;
  }

  list(): SecretEntrySummary[] {
    return [...this.memory.entries()]
      .map(([name, v]) => ({ name, updatedAt: v.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  delete(name: string): boolean {
    const ok = this.memory.delete(name);
    if (ok) this.flush();
    return ok;
  }

  /** Only requested names. Reserved names never leave the vault. */
  resolveNamed(names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of names) {
      const name = String(raw ?? '').trim();
      if (!name || isReservedEnvName(name)) continue;
      const value = this.memory.get(name)?.value;
      if (value != null) out[name] = value;
    }
    return stripReservedEnvNames(out);
  }

  /**
   * Internal snapshot for return-path redaction only.
   * Never expose plaintext values via public HTTP or tool APIs.
   */
  snapshotValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, entry] of this.memory.entries()) {
      if (!isReservedEnvName(name) && entry.value) {
        out[name] = entry.value;
      }
    }
    return out;
  }
}

export function parseSecretRefs(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.[SECRET_REFS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

export function runWithSecretRefs<T>(values: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  return als.run({ values: stripReservedEnvNames(values) }, async () => fn());
}

export function currentSecretOverrides(): Record<string, string> {
  return { ...(als.getStore()?.values ?? {}) };
}

/** Test helper: in-memory vault without persist. */
export function createMemorySecretVault(): SecretVault {
  return new SecretVault();
}
