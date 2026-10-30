#!/usr/bin/env node
/**
 * Thin smoke against a real agent-sandbox-microvm control plane.
 * Requires MICROVM_URL + MICROVM_API_KEY (+ MICROVM_INTERNAL_TOKEN for guest route).
 * Does not invent success: exits non-zero on any step failure.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function loadSmoke() {
  const candidates = [
    join(__dirname, '../dist/sandbox/microvm-control-plane.js'),
    join(__dirname, '../src/sandbox/microvm-control-plane.ts')
  ];
  for (const c of candidates) {
    try {
      if (c.endsWith('.ts')) {
        // Prefer compiled dist; ts path only if runner supports it.
        continue;
      }
      return await import(c);
    } catch {
      /* try next */
    }
  }
  // Fallback: dynamic import compiled after build, else relative from package root dist
  return import('../dist/sandbox/microvm-control-plane.js');
}

const { smokeMicrovmLifecycle, resolveMicrovmApiKey } = await loadSmoke();
const { resolveMicrovmRemoteUrl } = await import('../dist/sandbox/microvm-remote-url.js');

const url = resolveMicrovmRemoteUrl(process.env);
const key = resolveMicrovmApiKey(process.env);
if (!url) {
  console.error('BLOCKER: MICROVM_URL not set');
  process.exit(2);
}
if (!key) {
  console.error('BLOCKER: MICROVM_API_KEY not set');
  process.exit(2);
}

console.log(`smoke MICROVM_URL=${url}`);
const evidence = await smokeMicrovmLifecycle({ timeoutSeconds: 120 });
console.log(JSON.stringify({ ok: true, ...evidence }, null, 2));
