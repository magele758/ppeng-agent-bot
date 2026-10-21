import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

export function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: sanitizeScriptEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}

export function baseRevision(root, env = process.env) {
  // Fixture roots without a Git repository have no historical obligations.
  try { git(root, ['rev-parse', '--show-toplevel']); } catch { return null; }
  // workflow_call retains the caller's event, including the full push range.
  const eventBase = env.GITHUB_EVENT_NAME === 'push' ? env.CI_PUSH_BEFORE
    : env.GITHUB_EVENT_NAME === 'pull_request' ? env.CI_PR_BASE_SHA : null;
  if (eventBase && !/^0+$/.test(eventBase)) {
    try { return git(root, ['rev-parse', '--verify', '--end-of-options', `${eventBase}^{commit}`]); } catch { /* Use the fallback when unavailable. */ }
  }
  let base;
  try { base = git(root, ['merge-base', 'HEAD', 'origin/main']); } catch { /* Fall back to the parent. */ }
  // On main itself, compare with its parent so a same-commit relaxation is visible.
  return !base || base === git(root, ['rev-parse', 'HEAD']) ? git(root, ['rev-parse', 'HEAD^']) : base;
}

export function compareAcceptance(base, current) {
  const errors = [];
  const rank = { draft: 0, approved: 1, implemented: 2, retired: -1 };
  for (const prior of base) {
    if (!['approved', 'implemented'].includes(prior.status)) continue;
    const next = current.find(s => s.id === prior.id);
    const documentedRetirement = next?.status === 'retired' && typeof next.retiredReason === 'string' && next.retiredReason.trim()
      && next.requirement === prior.requirement
      && JSON.stringify(next.criteria) === JSON.stringify(prior.criteria);
    if (!next || (rank[next.status] < rank[prior.status] && !documentedRetirement)) errors.push(`${prior.id}: acceptance status removed/downgraded from ${prior.status}`);
    if (next && (prior.verificationStage ?? 'software') === 'software' && (next.verificationStage ?? 'software') !== 'software') errors.push(`${prior.id}: approved software stage moved out of the software gate`);
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
    if (!prior || entry.crap > prior.crap) errors.push(`CRAP baseline relaxed: ${key}`);
  }
  return errors;
}
