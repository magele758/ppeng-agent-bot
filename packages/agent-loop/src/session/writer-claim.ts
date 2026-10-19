/**
 * WAL writer claim (A4 / Phase 3). Empty claim permits legacy writes without an explicit expected id.
 * A non-empty `activeWriterRunId` requires a matching expected / bound id.
 */

import { AppError } from '../errors.js';

export class WriterClaimError extends AppError {
  readonly sessionId: string;
  readonly expected?: string;
  readonly actual?: string;

  constructor(sessionId: string, expected: string | undefined, actual: string | undefined) {
    super(
      'WRITER_CLAIM_MISMATCH',
      `WAL writer claim mismatch for session ${sessionId}: expected ${expected ?? '<none>'}, active ${actual ?? '<none>'}`,
      409
    );
    this.sessionId = sessionId;
    this.expected = expected;
    this.actual = actual;
  }
}

export function assertWriterClaim(input: {
  sessionId: string;
  activeWriterRunId?: string | null;
  expectedWriterRunId?: string;
  boundWriterRunId?: string;
}): void {
  const active = input.activeWriterRunId || undefined;
  if (!active) {
    if (input.expectedWriterRunId !== undefined) throw new WriterClaimError(input.sessionId, input.expectedWriterRunId, undefined);
    return;
  }
  const expected = input.expectedWriterRunId ?? input.boundWriterRunId;
  if (expected !== active) {
    throw new WriterClaimError(input.sessionId, expected, active);
  }
}
