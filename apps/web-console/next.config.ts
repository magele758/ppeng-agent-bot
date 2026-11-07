import type { NextConfig } from 'next';
import { createHash, type Hash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(appRoot, '..', '..');

function hashDirectory(hash: Hash, directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    hash.update(entry.name).update('\0');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) hashDirectory(hash, path);
    else hash.update(readFileSync(path));
  }
}

/** Config is evaluated by multiple build workers; wall-clock IDs disagree. */
function sourceBuildId(): string {
  const hash = createHash('sha256');
  for (const name of ['app', 'components', 'lib', 'styles']) {
    hash.update(name);
    hashDirectory(hash, join(appRoot, name));
  }
  for (const name of ['next.config.ts', 'middleware.ts', 'package.json', 'tsconfig.json']) {
    hash.update(readFileSync(join(appRoot, name)));
  }
  return hash.digest('hex').slice(0, 20);
}

/** API proxy configuration remains runtime-only in middleware.ts. */
const nextConfig: NextConfig = {
  output: 'standalone',
  productionBrowserSourceMaps: true,
  env: { NEXT_PUBLIC_BUILD_ID: sourceBuildId() },
  devIndicators: false,
  outputFileTracingRoot: repoRoot,
  eslint: { ignoreDuringBuilds: true }
};

export default nextConfig;
