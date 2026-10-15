import { readFileSync } from 'node:fs';
export const knownFlaky = JSON.parse(readFileSync(new URL('./known-flaky.json', import.meta.url), 'utf8'));
export function isKnownFlaky(file, name, entries = knownFlaky) {
  return entries.some(entry => entry.file === file && entry.name === name && typeof entry.reason === 'string' && entry.reason.trim());
}
