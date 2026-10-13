import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Captured before execution, so a later build cannot relabel an older runner. */
export function readExecutableFingerprint() {
  const files = {};
  for (const path of [
    'rooms/index.js', 'rooms/tool-policy.js', 'bots/bot-work.js', 'bots/bot-identity.js',
    'runtime/session-facade.js', 'storage.js', 'stores/migrations/index.js'
  ]) files[path] = createHash('sha256').update(readFileSync(new URL(`../../packages/core/dist/${path}`, import.meta.url))).digest('hex');
  for (const name of ['room-kill-fixture.mjs','bot-work-kill-fixture.mjs'])
    files[`fixture/${name}`] = createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex');
  return { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

/** Hash every regular build artifact, including nested and hidden files, without external CLI dependencies. */
export function readBuildTreeFingerprint(roots) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const root of roots) visit(root);
  files.sort();
  const digest = value => createHash('sha256').update(value).digest('hex');
  return { count: files.length, hash: digest(files.map(path => `${path}:${digest(readFileSync(path))}`).join('\n')) };
}
