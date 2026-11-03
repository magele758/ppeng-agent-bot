import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function directoryHasFile(path) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return false;
  }
  if (info.isFile()) return true;
  if (!info.isDirectory()) return false;
  const pending = [path];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isFile()) return true;
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return false;
}

export function missingRequiredArtifacts(paths, hasFile) {
  return paths.filter(path => !hasFile(path));
}

function main() {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error('no artifact paths');
    process.exitCode = 1;
    return;
  }
  const missing = missingRequiredArtifacts(paths, directoryHasFile);
  if (!missing.length) return;
  for (const path of missing) console.error(path);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
