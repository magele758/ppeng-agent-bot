import type { SkillSpec } from '../types.js';
import {
  loadAgentsDirSkills,
  loadStateDirSkills,
  loadWorkspaceSkills,
  mergeSkillsByName,
  parseSkillFrontmatter
} from './skill-registry.js';
import { ensureRepoTrust } from '../trust/repo-trust.js';
import { PLANNING_SKILL_MANIFEST } from './skill-manifest.js';

export { loadAgentsDirSkills, loadStateDirSkills, loadWorkspaceSkills, mergeSkillsByName, parseSkillFrontmatter };

export const builtinSkills: SkillSpec[] = [
  {
    id: 'planning',
    name: 'Planning',
    aliases: ['Tasks', 'tasks'],
    manifest: PLANNING_SKILL_MANIFEST,
    description: 'Plan multi-step work with TodoWrite and track durable tasks with dependencies.',
    content:
      'Use this when the task has multiple concrete steps.\n\n' +
      'Workflow:\n' +
      '1. Break the work into a short todo list before broad edits.\n' +
      '2. Keep exactly one item in progress at a time.\n' +
      '3. Update the todo list as scope changes so the shared state stays accurate.\n' +
      '4. Close the loop by marking completed work and calling out remaining risks.\n' +
      '5. For work spanning turns, use task_create, task_update and task_list; record dependencies with blockedBy and keep status and handoff metadata current.',
    promptFragment: 'Break substantial work into a tracked todo list before making broad changes.',
    triggerWords: ['plan', 'roadmap', 'steps', 'todo', 'task', 'dependency', 'blocked'],
    source: 'builtin'
  },
  {
    id: 'subagents',
    name: 'Subagents',
    aliases: ['Team', 'team'],
    description: 'Delegate bounded work to subagents and coordinate teammates with explicit ownership.',
    content:
      'Use this when a task can be parallelized without sharing a large amount of context.\n\n' +
      'Guidelines:\n' +
      '1. Delegate only bounded tasks with a clear deliverable.\n' +
      '2. Keep ownership explicit so workers do not fight over the same files.\n' +
      '3. Do immediate critical-path work locally; avoid delegating what blocks the next step.\n' +
      '4. Reuse the result to integrate or verify rather than redoing the delegated work.\n' +
      '5. For asynchronous teamwork, use spawn_teammate and send_message through the mailbox; hand off scope, status and next action, and keep coordination artifacts readable.',
    promptFragment: 'Delegate only concrete, bounded tasks that benefit from clean context.',
    triggerWords: ['delegate', 'subagent', 'parallel', 'team', 'teammate', 'mailbox', 'handoff'],
    source: 'builtin'
  },
  {
    id: 'guided-learning',
    name: 'Guided learning',
    description: 'Coach the user through implementation without taking over; prefer plan, hint, and review checkpoints.',
    content:
      'Use this when the user wants to learn by doing rather than fully delegate the implementation.\n\n' +
      'Workflow:\n' +
      '1. Start by discussing a stepwise plan and wait for confirmation before moving deeper.\n' +
      '2. Keep a lightweight shared plan (e.g. plan.md) with steps, checklist items, and notes so progress survives interruptions.\n' +
      '3. Default to guidance, not takeover. A "hint" should be one targeted nudge. A review/checkpoint should inspect the current work for correctness, idioms, and edge cases, then either approve the step or give focused feedback.\n' +
      '4. Do not write, edit, or generate the full implementation unless the user explicitly asks for that level of help.\n' +
      '5. Adjust plan granularity to the learner: detailed when they are new, more abstract as they gain confidence.',
    promptFragment:
      'When the user is learning, coach instead of taking over: agree a stepwise plan, prefer hint/review checkpoints, and avoid writing code unless explicitly asked.',
    aliases: ['learning mode', 'guide mode', 'coaching mode'],
    triggerWords: ['learn', 'learning', 'teach me', 'guide me', 'walk me through', 'coach me', 'hint', 'review my work', 'checkpoint', 'plan.md'],
    source: 'builtin'
  },
  {
    id: 'harness-long-running',
    name: 'Long-running harness',
    description:
      'Anthropic-style planner / generator / evaluator loop: spec, sprint contracts, external QA, structured artifacts.',
    content:
      'Use this for multi-hour or multi-feature work that benefits from durable artifacts and explicit checkpoints.\n\n' +
      'Workflow:\n' +
      '1. Planner expands the request into a product spec with sprint-sized chunks.\n' +
      '2. Before coding, record scope and testable acceptance criteria, then implement within the user authorization; ask only when a required decision is missing.\n' +
      '3. Generator implements one sprint at a time.\n' +
      '4. Evaluator or reviewer checks the result skeptically and records feedback.\n' +
      '5. Store product_spec, requirements_backlog (when applicable), sprint_contract, and evaluator_feedback under .raw-agent-harness/ and use task_create/task_update for dependencies and sequencing.',
    promptFragment:
      'For multi-hour or multi-feature builds: (1) Planner expands a short prompt into a high-level product spec—deliverables and sprint-sized chunks, not fragile low-level API details; maintain requirements_backlog with numbered verifiable requirements when the shape is clear. (2) Generator implements one sprint at a time; before code, record scope and testable acceptance criteria without adding a redundant approval checkpoint; after implementation, prefer spawn_subagent(role=evaluator) or role=review for verification. (3) Evaluator is skeptical, checks edge cases, and records feedback—do not rubber-stamp. Use harness_write_spec for product_spec, requirements_backlog, sprint_contract, and evaluator_feedback under .raw-agent-harness/. Use task_create with blockedBy for feature ordering. On huge contexts, rely on compaction plus these files for handoff.',
    triggerWords: ['harness', 'sprint', 'planner', 'evaluator', 'long-running', 'spec', 'contract'],
    source: 'builtin'
  }
];

export async function loadAllSkills(repoRoot: string = process.cwd(), stateDir?: string): Promise<SkillSpec[]> {
  const repoTrusted = !stateDir || ensureRepoTrust(stateDir, repoRoot).trusted;
  const ws = repoTrusted ? await loadWorkspaceSkills(repoRoot) : [];
  const user = await loadStateDirSkills(stateDir);
  const agents = await loadAgentsDirSkills();
  return mergeSkillsByName(mergeSkillsByName(mergeSkillsByName(builtinSkills, ws), user), agents);
}

export function matchSkills(goal: string, skills = builtinSkills): SkillSpec[] {
  const lowerGoal = goal.toLowerCase();
  return skills.filter((skill) =>
    skill.triggerWords?.some((word) => {
      const normalized = word.trim().toLowerCase();
      return normalized.length > 0 && lowerGoal.includes(normalized);
    })
  );
}
