import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import { activeVault } from './session-obsidian.js';

type Store = Pick<RawAgentRuntime['store'], 'getDaemonControl' | 'setDaemonControl' | 'deleteDaemonControl'>;
const key = 'obsidian-vault-path';

export function resolveVault(store: Store, detect = activeVault): Promise<string> {
  const configured = store.getDaemonControl<string>(key);
  return configured ? Promise.resolve(configured) : detect();
}

export async function configureVault(store: Store, input: unknown) {
  if (typeof input !== 'string') throw new ValidationError('obsidian_invalid_path');
  const value = input.trim();
  if (!value) {
    store.deleteDaemonControl(key);
    return;
  }
  if (!path.isAbsolute(value)) throw new ValidationError('obsidian_invalid_path');
  let root: string;
  try {
    root = await realpath(value);
    if (!(await lstat(path.join(root, '.obsidian'))).isDirectory()) throw new Error();
  } catch {
    throw new ValidationError('obsidian_invalid_path');
  }
  store.setDaemonControl(key, root);
}

export async function vaultSettings(store: Store) {
  const configuredPath = store.getDaemonControl<string>(key) ?? '';
  const effective = configuredPath || await activeVault().catch(() => '');
  return { configuredPath, destination: effective ? path.join(effective, 'Agent Home') : '' };
}
