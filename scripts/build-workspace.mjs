#!/usr/bin/env node
/**
 * Compiles TypeScript workspace packages via `tsc -b`.
 * Domain package paths come from domains.manifest.json (no hardcoding).
 */
import { execSync } from 'node:child_process';
import { domainPackagePaths, repoRoot } from './lib/domains-manifest.mjs';

const projects = [
  'packages/api-types',
  'packages/core',
  'packages/capability-gateway',
  ...domainPackagePaths(),
  'packages/daemon-client',
  'apps/daemon',
  'apps/cli',
];

const cmd = ['pnpm', 'exec', 'tsc', '-b', ...projects];
console.log(`[build-workspace] ${cmd.join(' ')}`);
execSync(cmd.join(' '), { cwd: repoRoot, stdio: 'inherit' });
