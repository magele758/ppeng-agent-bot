import type { SkillSpec } from '../types.js';
import {
  loadAgentsDirSkills,
  loadStateDirSkills,
  loadWorkspaceSkills,
  mergeSkillsByName,
  parseSkillFrontmatter
} from './skill-registry.js';
import { PLANNING_SKILL_MANIFEST } from './skill-manifest.js';

export { loadAgentsDirSkills, loadStateDirSkills, loadWorkspaceSkills, mergeSkillsByName, parseSkillFrontmatter };

export const builtinSkills: SkillSpec[] = [
  {
    id: 'planning',
    name: 'Planning',
    manifest: PLANNING_SKILL_MANIFEST,
    description: 'Use TodoWrite for multi-step work and keep exactly one item in progress.',
    content:
      'Use this when the task has multiple concrete steps.\n\n' +
      'Workflow:\n' +
      '1. Break the work into a short todo list before broad edits.\n' +
      '2. Keep exactly one item in progress at a time.\n' +
      '3. Update the todo list as scope changes so the shared state stays accurate.\n' +
      '4. Close the loop by marking completed work and calling out remaining risks.',
    promptFragment: 'Break substantial work into a tracked todo list before making broad changes.',
    triggerWords: ['plan', 'roadmap', 'steps', 'todo'],
    source: 'builtin'
  },
  {
    id: 'subagents',
    name: 'Subagents',
    description: 'Use spawn_subagent for bounded exploration or isolated implementation work.',
    content:
      'Use this when a task can be parallelized without sharing a large amount of context.\n\n' +
      'Guidelines:\n' +
      '1. Delegate only bounded tasks with a clear deliverable.\n' +
      '2. Keep ownership explicit so workers do not fight over the same files.\n' +
      '3. Do immediate critical-path work locally; avoid delegating what blocks the next step.\n' +
      '4. Reuse the result to integrate or verify rather than redoing the delegated work.',
    promptFragment: 'Delegate only concrete, bounded tasks that benefit from clean context.',
    triggerWords: ['delegate', 'subagent', 'parallel', 'research'],
    source: 'builtin'
  },
  {
    id: 'skills',
    name: 'Skills',
    description: 'Load workspace skills only when they are relevant.',
    content:
      'Use this when a named skill or a clearly relevant workflow exists.\n\n' +
      'Guidelines:\n' +
      '1. Check the routed shortlist first.\n' +
      '2. Call load_skill(name) only for skills that materially help with the current turn.\n' +
      '3. Prefer loading a small number of relevant skills over front-loading large reference text.\n' +
      '4. If strict routing is enabled, stay within the current shortlist.',
    promptFragment: 'Use load_skill instead of front-loading large reference documents.',
    triggerWords: ['skill', 'guide', 'reference'],
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
    id: 'compression',
    name: 'Compression',
    description: 'Compact context when sessions become large and preserve continuity in summaries.',
    content:
      'Use this when the session is getting large or handoffs are becoming fragile.\n\n' +
      'Guidelines:\n' +
      '1. Preserve active tasks, decisions, and unresolved risks.\n' +
      '2. Prefer concise summaries over replaying large histories.\n' +
      '3. Keep continuity artifacts current before compacting context.',
    promptFragment: 'Keep context lean. Summaries should preserve active tasks, decisions, and risks.',
    triggerWords: ['compact', 'summary', 'context'],
    source: 'builtin'
  },
  {
    id: 'tasks',
    name: 'Tasks',
    description: 'Represent long-lived work as persistent tasks with dependencies.',
    content:
      'Use this when work needs durable state beyond the current turn.\n\n' +
      'Guidelines:\n' +
      '1. Create persistent tasks for long-lived work.\n' +
      '2. Record dependencies explicitly with blockedBy.\n' +
      '3. Update status and metadata as execution progresses.\n' +
      '4. Use tasks for handoffs and sequencing, not just temporary reminders.',
    promptFragment: 'Use task_create, task_update, and task_list for durable multi-step work.',
    triggerWords: ['task', 'dependency', 'blocked'],
    source: 'builtin'
  },
  {
    id: 'team',
    name: 'Team',
    description: 'Use teammates and mailbox messages for asynchronous coordination.',
    content:
      'Use this when multiple agents or long-running sessions need explicit coordination.\n\n' +
      'Guidelines:\n' +
      '1. Split work by ownership.\n' +
      '2. Use teammates only when parallelism is real, not just possible in theory.\n' +
      '3. Send concise handoffs with scope, status, and next action.\n' +
      '4. Keep coordination artifacts readable enough for later recovery.',
    promptFragment: 'When work is truly parallelizable, spawn_teammate and send_message with clear ownership.',
    triggerWords: ['team', 'teammate', 'mailbox', 'handoff'],
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
      '2. Before coding, agree a sprint contract with scope and testable acceptance criteria.\n' +
      '3. Generator implements one sprint at a time.\n' +
      '4. Evaluator or reviewer checks the result skeptically and records feedback.\n' +
      '5. Store product_spec, requirements_backlog (when applicable), sprint_contract, and evaluator_feedback under .raw-agent-harness/ and use task_create/task_update for dependencies and sequencing.',
    promptFragment:
      'For multi-hour or multi-feature builds: (1) Planner expands a short prompt into a high-level product spec—deliverables and sprint-sized chunks, not fragile low-level API details; maintain requirements_backlog with numbered verifiable requirements when the shape is clear. (2) Generator implements one sprint at a time; before code, agree a sprint contract (scope + testable acceptance criteria); after implementation, prefer spawn_subagent(role=evaluator) or role=review for verification. (3) Evaluator is skeptical, checks edge cases, and records feedback—do not rubber-stamp. Use harness_write_spec for product_spec, requirements_backlog, sprint_contract, and evaluator_feedback under .raw-agent-harness/. Use task_create with blockedBy for feature ordering. On huge contexts, rely on compaction plus these files for handoff.',
    triggerWords: ['harness', 'sprint', 'planner', 'evaluator', 'long-running', 'spec', 'contract'],
    source: 'builtin'
  }
];

export async function loadAllSkills(repoRoot: string = process.cwd(), stateDir?: string): Promise<SkillSpec[]> {
  const ws = await loadWorkspaceSkills(repoRoot);
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
