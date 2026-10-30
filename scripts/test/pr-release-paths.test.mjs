import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASE_GATE_PATHS, touchesReleaseGatePaths} from '../ci/pr-release-paths.mjs';

test('core paths trigger Formal-only on PR [AC:ci-action-reliability#AC-9]', () => {
  for (const file of [
    'packages/core/src/runtime.ts',
    'packages/agent-loop/package.json',
    'packages/capability-gateway/src/a.ts',
    'packages/api-types/index.ts',
    'apps/daemon/src/server.ts',
    'specs/formal/x.md',
    'scripts/formal/run.mjs',
    'scripts/crap/crap-gate.mjs',
    'scripts/ci/validation-lane.mjs',
    'scripts/ci/validation-anything.mjs',
    'scripts/ci/main-full-health.mjs',
    'scripts/ci/test-partition.mjs',
    '.github/workflows/ci.yml',
    '.github/workflows/pr-release-gate.yml',
    '.github/workflows/formal-only.yml',
    '.github/workflows/release-gate.yml',
    '.github/workflows/full-validation.yml',
  ]) assert.equal(touchesReleaseGatePaths([file]), true, file);
});

test('non-core-only changes do not trigger Formal-only [AC:ci-action-reliability#AC-9]', () => {
  for (const file of [
    'doc/CI.md',
    'docs/x.md',
    'README.md',
    'packages/agent-erp/src/a.ts',
    'packages/agent-homeiot/src/a.ts',
    'packages/agent-sre/src/a.ts',
    'packages/agent-stock/src/a.ts',
    'apps/web-console/components/A.tsx',
    'apps/desktop/main.ts',
    'scripts/ci/quick-gate.mjs',
    'scripts/ci/validation/nested.mjs',
    'packages/core-extra/a.ts',
    '.github/workflows/other.yml',
  ]) assert.equal(touchesReleaseGatePaths([file]), false, file);
  assert.equal(touchesReleaseGatePaths([]), false);
});

test('one core file among non-core files triggers the gate [AC:ci-action-reliability#AC-9]', () => {
  assert.equal(touchesReleaseGatePaths(['doc/CI.md', 'apps/web-console/a.tsx', 'packages/core/a.ts']), true);
});

test('include list is the approved set [AC:ci-action-reliability#AC-9]', () => {
  assert.equal(RELEASE_GATE_PATHS.length, 21);
});
