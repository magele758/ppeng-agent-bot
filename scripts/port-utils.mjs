/**
 * Local port probe + backoff for dev-lab (and similar).
 * Checks both 127.0.0.1 and :: so IPv4-only / IPv6 dual-stack holders are detected.
 */
import net from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function tryListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      // EADDRINUSE => busy; other errors (e.g. no IPv6) => treat as non-blocking
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      resolve(true);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen({ port, host, ipv6Only: host === '::' });
    } catch {
      resolve(true);
    }
  });
}

/** @returns {Promise<boolean>} true if port is free on loopback IPv4 and IPv6 (when available) */
export async function isPortFree(port) {
  // Probe the actual Next bind address too: macOS can permit a specific bind
  // while a wildcard holder would still block Next's 0.0.0.0 listener.
  if (!await tryListen(port, '0.0.0.0')) return false;
  const v4 = await tryListen(port, '127.0.0.1');
  if (!v4) return false;
  const v6 = await tryListen(port, '::');
  return v6;
}

/**
 * Prefer `preferred`, then preferred+1 … preferred+span-1.
 * @returns {Promise<number>}
 */
export async function pickPort(preferred, span = 20) {
  const base = Number(preferred);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Invalid preferred port: ${preferred}`);
  }
  for (let i = 0; i < span; i += 1) {
    const port = base + i;
    if (port > 65535) break;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${base}..${Math.min(65535, base + span - 1)}`);
}

export function writeDevLabPortsFile(filePath, info) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}
