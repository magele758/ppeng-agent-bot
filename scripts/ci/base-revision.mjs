import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

export function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: sanitizeScriptEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}

export function baseRevision(root) {
  // Fixture roots without a Git repository have no historical obligations.
  try { git(root, ['rev-parse', '--show-toplevel']); } catch { return null; }
  const base = git(root, ['merge-base', 'HEAD', 'origin/main']);
  // On main itself, compare with its parent so a same-commit relaxation is visible.
  return base === git(root, ['rev-parse', 'HEAD']) ? git(root, ['rev-parse', 'HEAD^']) : base;
}

export function compareAcceptance(base, current) {
  const errors = [];
  const rank = { draft: 0, approved: 1, implemented: 2, retired: -1 };
  for (const prior of base) {
    if (!['approved', 'implemented'].includes(prior.status)) continue;
    const next = current.find(s => s.id === prior.id);
    if (!next || rank[next.status] < rank[prior.status]) errors.push(`${prior.id}: acceptance status removed/downgraded from ${prior.status}`);
    for (const criterion of prior.criteria) {
      if (!next?.criteria.some(c => c.id === criterion.id)) errors.push(`${prior.id}#${criterion.id}: base criterion removed`);
    }
  }
  return errors;
}

export function compareBaselines(base, current) {
  const errors = [];
  if ((current?.threshold ?? 30) > (base?.threshold ?? 30)) errors.push('CRAP baseline threshold relaxed');
  for (const [key, entry] of Object.entries(current?.functions ?? {})) {
    const prior = base?.functions?.[key];
    if (!prior || entry.crap > prior.crap || (prior.coverage === 0 && entry.coverage !== 0)) errors.push(`CRAP baseline relaxed: ${key}`);
  }
  return errors;
}
