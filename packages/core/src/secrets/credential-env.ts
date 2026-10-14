import { ValidationError } from '../errors.js';
import { assertWritableEnvName } from './reserved-env-names.js';

/** Operator tokens software connections already refuse as credential names. */
export const OPERATOR_CREDENTIAL_DENY = new Set([
  'RAW_AGENT_AUTH_TOKEN',
  'RAW_AGENT_HUMAN_RELEASE_SECRET'
]);

export function assertCredentialEnvName(name: string): void {
  try {
    assertWritableEnvName(name);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'invalid credential env name');
  }
  if (OPERATOR_CREDENTIAL_DENY.has(name)) {
    throw new ValidationError('Operator credential cannot be used for software execution');
  }
}
