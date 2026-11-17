import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatHash, parseHash } from '../../apps/web-console/lib/nav.ts';

export function validateLocations(root, cases) {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const item of cases) {
    if (!item.route || formatHash(parseHash(item.route)) !== item.route) {
      throw new Error(item.id + ': invalid Lab route ' + item.route);
    }
    if (!Array.isArray(item.aliases) || !item.aliases.length || item.aliases.some(word => typeof word !== 'string' || !word.trim())) {
      throw new Error(item.id + ': missing user vocabulary');
    }
    if (!Array.isArray(item.sources) || !item.sources.length) throw new Error(item.id + ': missing source files');
    for (const path of item.sources) {
      if (!statSync(join(root, path), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(item.id + ': missing source file ' + path);
      }
    }
    if (item.exploration && !Object.hasOwn(scripts, item.exploration)) {
      throw new Error(item.id + ': missing package script ' + item.exploration);
    }
  }
}

export function findJourneys(cases, text) {
  const query = text.trim().toLowerCase();
  if (!query) return cases;
  const exact = cases.find(item => item.id === query);
  if (exact) return [exact];
  const matches = cases.map(item => {
    const terms = new Set([item.id, item.title, item.route, ...item.aliases, ...item.specs]);
    let score = 0;
    for (const term of terms) {
      const word = term.toLowerCase();
      if (word.includes(query) || query.includes(word)) score++;
    }
    return { item, score };
  });
  return matches.filter(hit => hit.score).sort((a, b) => b.score - a.score).map(hit => hit.item);
}
