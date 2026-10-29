export {
  SECRET_VAULT_KEY,
  SECRET_REFS_METADATA_KEY,
  SecretVault,
  createMemorySecretVault,
  parseSecretRefs,
  runWithSecretRefs,
  currentSecretOverrides,
  bindSecretVault,
  getBoundSecretVault
} from './secret-vault.js';
export type { SecretVaultStore, SecretEntrySummary } from './secret-vault.js';
export {
  ENV_NAME_RE,
  isReservedEnvName,
  assertWritableEnvName,
  stripReservedEnvNames,
  RESERVED_ENV_NAME_HINT,
  ENV_NAME_GRAMMAR_HINT
} from './reserved-env-names.js';
export {
  USER_VAULT_KEY,
  USER_VAULT_REF_PREFIX,
  UserVault,
  createMemoryUserVault,
  bindUserVault,
  getBoundUserVault,
  makeUserVaultFillRef,
  parseUserVaultFillRef,
  fillByReferences,
  assertModelFacingHasNoUserVaultSecrets,
  isUserVaultFillRef
} from './user-vault.js';
export type {
  UserVaultStore,
  UserVaultEntryKind,
  UserVaultSecretField,
  UserVaultFillField,
  UserVaultFillRef,
  UserVaultEntrySummary,
  UserVaultPersist,
  FillByRefModelReport
} from './user-vault.js';
