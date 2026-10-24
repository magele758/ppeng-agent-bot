import { HISTORICAL_SUMMARY_NOTICE } from '../session/context-sources.js';
import { toolDirectory } from '../tools/tool-exposure.js';
import {readBotSkillSelection, selectBotSkills} from '../skills/bot-selection.js';
import { filterSkillsByBot, sessionBotId } from '../skills/bot-scope.js';
/**
 * Prompt builder: constructs the stable system prefix and dynamic per-turn context.
 *
 * Extracted from RawAgentRuntime to isolate system prompt construction from runtime orchestration.
 */

import { envBool, envInt } from '../env.js';
import { PRIVATE_CHAT_GROUP_SPEAKER_RULE } from '../rooms/speaker-identity.js';
import { buildTaskContext } from '../session/task-context.js';
import { resolveDiscoveryEnabled } from '../discovery/settings.js';
import {
  builtinSkills,
  loadAgentsDirSkills,
  loadStateDirSkills,
  loadWorkspaceSkills,
  mergeSkillsByName
} from '../skills/builtin-skills.js';
import {
  buildSkillRoutingCooperative,
  skillLoadStrictFromEnv,
  skillRoutingModeFromEnv,
  skillRoutingTopKFromEnv,
  type SkillRoutingMode,
  type SkillRoutingResult,
} from '../skills/skill-router.js';
import { filterSkillsByAllowlist, readAllowedSkillNames } from '../skills/skill-allowlist.js';
import {
  resolveSkillDisclosureMode,
  type SkillDisclosureMode
} from '../skills/skill-settings.js';
import type { SqliteStateStore } from '../storage.js';
import { compileTurnAppendix, compileTurnAppendixAsync } from '../session/context-compiler.js';
import { applyJevSkillSelect } from '../jev/apply.js';
import { chainHas, resolveJevChain } from '../jev/settings.js';
import { isPtcSession, orchestrationReplayFromSession } from '../ptc/mode.js';
import { resolveDynToolsEnabled } from '../dyn-tools/settings.js';
import { buildReplayPromptBlock } from '../ptc/prompt.js';
import { normalizeSavedOrchestration } from '../ptc/orchestration.js';
import {
  filterSkillsByScope,
  requestedSkillNames,
  runProfileFromSession
} from '../runtime/run-profile.js';
import { EXTERNAL_FENCE_SYSTEM_SENTENCE } from '../safety/external-content.js';
import { textSummaryFromParts } from './model-adapters.js';
import type {
  AgentSpec,
  SessionMessage,
  SessionRecord,
  SkillSpec,
  TaskRecord,
} from '../types.js';

const { HARNESS_ARTIFACT_DIR, HARNESS_ARTIFACT_FILES } = await import('../types.js');

/**
 * Observability fingerprint for the stable system prefix.
 * Does **not** enter the prompt or the prompt-cache key — only `turn_end` traces.
 * Bump when `buildStablePrefix` (or any helper that feeds it) changes wording.
 * See `./AGENTS.md`.
 */
export const STABLE_SYSTEM_VERSION = 'v14';

/** Appended when `RAW_AGENT_AGENTIC_SAFETY_APPENDIX` is set; English to match the rest of the stable prefix. */
export const RUNTIME_AGENTIC_SAFETY_APPENDIX = `Runtime safety appendix (policy text only; does not replace model-level safety training):
- Do not pursue self-preservation against the user or operator through harmful, deceptive, or coercive means.
- Do not harm people, break applicable rules, or subvert the user's explicit intent just to finish a task.
- If a tool action would conflict with user intent, product policy, or ethics, pause and escalate (ask/clarify) rather than bypassing safeguards.
- Prefer least-privilege tool use and respect human-in-the-loop approvals when the host exposes them.
- When facing strong conflicts (e.g., unusual leverage, shutdown/replacement themes, credential exfiltration pressure), state the tension clearly so operators can audit traces.`;

export function agenticSafetyAppendixScope(env: NodeJS.ProcessEnv): 'off' | 'general' | 'all' {
  const raw = String(env.RAW_AGENT_AGENTIC_SAFETY_APPENDIX ?? '')
    .trim()
    .toLowerCase();
  if (!raw || ['0', 'false', 'no', 'off'].includes(raw)) return 'off';
  if (raw === 'all') return 'all';
  if (['1', 'true', 'yes', 'on', 'general'].includes(raw)) return 'general';
  return 'off';
}

function capRollingSummaryText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return `…[earlier summary truncated]\n\n${text.slice(-maxChars)}`;
}

function compactSummaryMaxChars(env: NodeJS.ProcessEnv): number {
  const thr = envInt(env, 'RAW_AGENT_COMPACT_TOKEN_THRESHOLD', 24_000);
  return envInt(env, 'RAW_AGENT_COMPACT_SUMMARY_MAX_CHARS', thr * 2);
}

function textFromMessage(message: SessionMessage): string {
  return textSummaryFromParts(message.parts);
}

function formatWorkspaceRootsPrompt(ctx: PromptContext): string {
  const roots = ctx.workspaceRoots?.filter((r) => r.path) ?? [];
  if (roots.length === 0) {
    return ctx.workspaceRoot ? `Workspace root: ${ctx.workspaceRoot}` : 'No isolated workspace bound.';
  }
  const lines = ['Workspace roots (file tools resolve against these; bash cwd is the primary root):'];
  for (const root of roots) {
    const tag = root.primary ? ' (primary)' : '';
    lines.push(`- @${root.alias}${tag}: ${root.path}`);
  }
  lines.push(
    'Path rules: `@alias/rel` selects a root; a relative path uses the primary root; an absolute path must stay inside an authorized root.'
  );
  return lines.join('\n');
}

export function buildDynToolsPromptBlock(enabled = false): string {
  if (!enabled) return '';
  return [
    '## Dynamic tools',
    'This turn\'s callable tools are exactly the current tools[] list.',
    'Historical tool_call names may already be retired; do not call a name that is not in this turn\'s tools[].',
    'Do not hard-code ephemeral harvested tool names in skill text.',
    'Harvest is explicit: you must call save_as_tool (name + description; optional code, else last ptcLastProgram). ptc_exec never auto-harvests.',
    'A tool that was already used stays hydrated even if later marked draft (sticky).',
    'propose_tool requires 1–3 fixtures; failures stay draft and are not hydrated unless already used.',
    'Harvested tools are reusable ptc_exec cells: isolate-only; approval and sideEffect inherit the highest inner authorized tool (never blanket auto).'
  ].join('\n');
}

export function buildPtcOrchestrationBlock(opts?: { jevDecide?: boolean }): string {
  const lines = [
    '## Dynamic workflow orchestration (PTC)',
    '',
    'You are the orchestrator. Write a short async JavaScript cell and call `ptc_exec`; do not emit a JSON worker list and do not call spawn_subagent directly.',
    '',
    'Inside the cell:',
    '- `agent({ task, angle?, agent?, role?, title?, allowed_tools?, model?, inherit_scratch?, summary_max_chars? })` runs a clean-context worker and returns its summary.',
    '- Authorized read-only tools are callable by name; non-identifier names are available through `tools["name"]`.',
    '- `scratchpad.write/read/list/delete` stores intermediates. write accepts (key, value) or { key, value, visibility, ttlSec, pin }. visibility is cell | session | inherit (default session). Unpinned ptc.* keys stay out of the parent memory appendix. agent() does not copy them unless inherit_scratch is true or a key list. Values cap at 8192 chars and 40 session keys.',
    '- `verify({ kind: "files_exist", paths: [...] })` or an allowed HTTP check throws when verification fails.'
  ];
  if (opts?.jevDecide) {
    lines.push(
      '- `jev.noul(instructions)` / `jev.choice(instructions, options)` decide semantic branches only (success / which enumerated path / retry). Options capped at 8. Returns null on failure — fall back to the LLM. Do not use for ordinary comparisons, tool args, approvals, or writing code/plans.'
    );
  }
  lines.push(
    '',
    'Workflow rules:',
    '1. Split the goal into self-contained, complementary tasks.',
    '2. Use `Promise.all([agent(...), agent(...)])` for independent work.',
    '3. Inspect worker results, cross-check conflicts, and run another focused round only when needed.',
    '4. Return one short synthesized result. Large payloads go to scratchpad; oversized returns spill to `__last_return`.',
    '5. Keep file writes, shell commands, and other mutations outside the cell as normal parent or worker tool calls.',
    '',
    'The cell cannot use require, process, bare fetch, eval, Function, WebAssembly, or dynamic import.'
  );
  return lines.join('\n');
}

export interface PromptContext {
  agent: AgentSpec;
  session: SessionRecord;
  task?: TaskRecord;
  repoRoot: string;
  workspaceRoot?: string;
  workspaceRoots?: Array<{ alias: string; path: string; primary?: boolean }>;
}

export interface SkillSearchHit {
  id?: string;
  ownerBotId?: string;
  name: string;
  description: string;
  score: number;
  reason: string;
}

function scoringModeForSearch(mode: SkillRoutingMode): SkillRoutingMode {
  return mode === 'legacy' ? 'hybrid' : mode;
}

function buildFullSkillBlock(skills: SkillSpec[], routing: SkillRoutingResult): string {
  const skillLines = skills.map((s) => `- ${s.name}${s.ownerBotId ? ` (Bot ${s.ownerBotId}, id: ${s.id})` : ""}: ${s.description}`).join('\n');
  const matchedLines = routing.keywordMatched
    .map((s) => `- ${s.name}: ${s.promptFragment ?? s.description}`)
    .join('\n');
  return [
    'Available skills:',
    skillLines || '(none)',
    routing.keywordMatched.length > 0 ? `Matched guidance:\n${matchedLines}` : 'No matched guidance.',
    'Call load_skill(name) for full SKILL.md. You may also call search_skills(query) to rank the catalog.'
  ].join('\n\n');
}

function buildShortlistSkillBlock(routing: SkillRoutingResult): string {
  const routedNames = new Set(routing.routed.map((r) => r.skill.id));
  const lines: string[] = [
    `Skill routing (${routing.mode}). Likely-relevant skills for this turn — call load_skill(name) for full SKILL.md:`,
    'Use exact skill names as shown. To find a skill not listed, call search_skills(query) then load_skill(name).'
  ];
  if (routing.routed.length === 0 && routing.keywordMatched.length === 0) {
    lines.push('(no strong matches — call search_skills, rely on tools, or ask a clarifying question)');
  }
  if (routing.confidence.level === 'low') {
    lines.push(`⚠️ Routing confidence: ${routing.confidence.level}. ${routing.confidence.reason}`);
    lines.push('Consider asking a clarifying question to narrow intent before loading skills.');
  } else if (routing.confidence.level === 'medium' && routing.confidence.nearTopCount > 1) {
    lines.push(`ℹ️ Routing confidence: ${routing.confidence.level}. ${routing.confidence.reason}`);
  }
  for (const r of routing.routed) {
    lines.push(`- ${r.skill.name}${r.skill.ownerBotId ? ` (Bot ${r.skill.ownerBotId}, id: ${r.skill.id})` : ""}: ${r.skill.description} [score=${r.score}; ${r.reason}]`);
  }
  for (const s of routing.keywordMatched) {
    if (routedNames.has(s.id)) continue;
    lines.push(`- ${s.name}${s.ownerBotId ? ` (Bot ${s.ownerBotId}, id: ${s.id})` : ""}: ${s.description} [keyword hint]`);
  }
  const strict = skillLoadStrictFromEnv(process.env);
  lines.push(
    strict
      ? 'Strict: only call load_skill for names listed above this turn.'
      : 'If you need a skill not listed, you may still call load_skill; off-shortlist loads are traced for routing quality.'
  );
  return lines.join('\n');
}

function buildLazySkillBlock(): string {
  return [
    'Skill disclosure (lazy). The skill catalog is not listed here.',
    'Call search_skills with a short task query, then load_skill(name) for the best match.',
    'Use exact names returned by search_skills.'
  ].join('\n');
}

function buildSkillCatalogBlock(
  disclosure: SkillDisclosureMode,
  skills: SkillSpec[],
  routing: SkillRoutingResult
): string {
  switch (disclosure) {
    case 'lazy':
      return buildLazySkillBlock();
    case 'full':
      return buildFullSkillBlock(skills, routing);
    case 'shortlist':
      return buildShortlistSkillBlock(routing);
    default: {
      const _never: never = disclosure;
      return _never;
    }
  }
}

export interface PromptBuilderDeps {
  runtimeInstructions?: (sessionId: string) => string;
  store: SqliteStateStore;
  repoRoot: string;
  /** When set, approved user skills under `<stateDir>/skills` are merged in. */
  stateDir?: string;
  /**
   * Domain-bundle SkillSpecs appended on top of the discovered set
   * (workspace + ~/.agents). Static for the lifetime of the runtime.
   */
  extraSkills?: SkillSpec[];
  /** Optional PG/Redis catalog skills (merged after workspace/~.agents). */
  cloudSkillsLoader?: () => Promise<SkillSpec[]>;
}

export class PromptBuilder {
  private workspaceSkillsPromise?: Promise<SkillSpec[]>;
  private readonly routingBySession = new Map<string, SkillRoutingResult>();
  private readonly searchHitsBySession = new Map<string, string[]>();
  /** Exposes last cognitive phase info by session (set externally by runtime). */
  lastCognitivePhaseBySession = new Map<string, { phase: string; confidence: number }>();

  constructor(private readonly deps: PromptBuilderDeps) {}

  /** Retrieve the latest routing result for a session (used by load_skill validation). */
  getRouting(sessionId: string): SkillRoutingResult | undefined {
    return this.routingBySession.get(sessionId);
  }

  /** Bot skill allowlist for a session; undefined means every skill. */
  getAllowedSkills(sessionId: string): string[] | undefined {
    const session =
      typeof this.deps.store.getSession === 'function'
        ? this.deps.store.getSession(sessionId)
        : undefined;
    return readAllowedSkillNames(session?.metadata);
  }

  getSkillDisclosure(): SkillDisclosureMode {
    return resolveSkillDisclosureMode({ store: this.deps.store, env: process.env });
  }

  /** Names returned by the latest search_skills call (lazy + strict load_skill). */
  getLastSkillSearchNames(sessionId: string): string[] | undefined {
    return this.searchHitsBySession.get(sessionId);
  }

  /**
   * Rank the catalog for search_skills. Always uses lexical/hybrid scoring
   * (legacy routing is listing-only and would make search useless).
   */
  async skillsForSession(sessionId: string): Promise<SkillSpec[]> {
    const session = typeof this.deps.store.getSession === 'function' ? this.deps.store.getSession(sessionId) : undefined;
    const botId = sessionBotId(session?.metadata);
    const visible = selectBotSkills(filterSkillsByBot(await this.allSkills(), botId), readBotSkillSelection(this.deps.store, botId));
    return session ? filterSkillsByScope(visible, runProfileFromSession(session).skillScope, requestedSkillNames(session.metadata)) : visible;
  }

  async searchSkills(query: string, sessionId: string, limit?: number): Promise<SkillSearchHit[]> {
    const topK =
      typeof limit === 'number' && Number.isFinite(limit)
        ? Math.min(20, Math.max(1, Math.floor(limit)))
        : skillRoutingTopKFromEnv(process.env);
    let skills = await this.skillsForSession(sessionId);
    const session =
      typeof this.deps.store.getSession === 'function'
        ? this.deps.store.getSession(sessionId)
        : undefined;
    if (session) {
      const profile = runProfileFromSession(session);
      skills = filterSkillsByAllowlist(
        filterSkillsByScope(skills, profile.skillScope, requestedSkillNames(session.metadata)),
        readAllowedSkillNames(session.metadata)
      );
    }
    const routing = await buildSkillRoutingCooperative(query.trim(), skills, {
      mode: scoringModeForSearch(skillRoutingModeFromEnv(process.env)),
      topK
    });
    const hits: SkillSearchHit[] = [];
    const seen = new Set<string>();
    for (const r of routing.routed) {
      seen.add(r.skill.id);
      hits.push({
        id: r.skill.id,
        ownerBotId: r.skill.ownerBotId,
        name: r.skill.name,
        description: r.skill.description,
        score: r.score,
        reason: r.reason
      });
    }
    for (const s of routing.keywordMatched) {
      if (seen.has(s.id)) continue;
      hits.push({
        id: s.id,
        ownerBotId: s.ownerBotId,
        name: s.name,
        description: s.description,
        score: 0,
        reason: 'keyword hint'
      });
    }
    this.searchHitsBySession.set(
      sessionId,
      hits.flatMap((h) => [h.id ?? h.name, h.name])
    );
    return hits;
  }

  /**
   * Build the stable prefix (agent identity, repo root, workspace, mode).
   * Substantive wording changes must bump {@link STABLE_SYSTEM_VERSION}.
   */
  buildStablePrefix(ctx: PromptContext): string {
    const harnessLines: string[] = [];
    if (ctx.agent.harnessRole === 'planner') {
      harnessLines.push(
        'Harness role: PLANNER — expand short goals into a high-level product spec and feature boundaries; avoid brittle low-level specs. Write product_spec.md via harness_write_spec; when the domain is clear, also maintain requirements_backlog.md (numbered, verifiable items: behaviour, NFR, UX, copy).',
      );
    } else if (ctx.agent.harnessRole === 'generator') {
      harnessLines.push(
        'Harness role: GENERATOR — one sprint/feature at a time. Write sprint_contract.md (scope + verifiable acceptance criteria) before deep implementation; after work, prefer external review via spawn_subagent(role=evaluator) or role=review.',
      );
    } else if (ctx.agent.harnessRole === 'evaluator') {
      harnessLines.push(
        'Harness role: EVALUATOR — skeptical QA; probe edge cases; document findings in evaluator_feedback.md. Do not rubber-stamp generator output.',
      );
    }
    if (ctx.agent.id === 'main' || (ctx.agent.capabilities.includes('orchestration') && !ctx.agent.capabilities.includes('bot'))) {
      harnessLines.push(
        `Long-running harness: orchestrate planner → generator sprints → evaluator; structured files under ${HARNESS_ARTIFACT_DIR}/ (${HARNESS_ARTIFACT_FILES.productSpec}, ${HARNESS_ARTIFACT_FILES.requirementsBacklog}, ${HARNESS_ARTIFACT_FILES.sprintContract}, ${HARNESS_ARTIFACT_FILES.evaluatorFeedback}).`,
      );
    }

    const workspaceLines = formatWorkspaceRootsPrompt(ctx);
    const base = [
      `You are ${ctx.agent.name} (${ctx.agent.role}).`,
      ctx.agent.instructions,
      `Repository root: ${ctx.repoRoot}`,
      workspaceLines,
      `Conversation mode: ${ctx.session.mode}`,
      'You are running in a raw agent loop. Respond normally when no tools are needed.',
      EXTERNAL_FENCE_SYSTEM_SENTENCE,
      'Only write artifacts required by the user or necessary to perform the requested task. Verification observations already in tool results are evidence; report them in the conversation without creating additional files, database records, or saved reports merely to prove completion. Explicitly requested reports and necessary task outputs remain authorized.',
      'Choose tools by their actual data source and capability. Resolve bare data identifiers with an exact-key lookup when available before assuming a filesystem path or searching conversation history. Use file tools for explicit file references or files established by discovery. Do not repeatedly guess filenames after a missing-file result; use an authorized lookup or discovery tool to locate the requested data. Once the input is available, complete the requested transformation and persistence, and verify the saved artifact before ending. Finding input or announcing the next action is not task completion.',
      'When the user specifies an exact output format or asks for only a value, return that format without explanations, headings, or verification reports. Perform necessary tools and checks, but keep progress narration out of a strict-format response.',
      'Use TodoWrite for multi-step work when it helps track remaining work; keep one item in progress and prioritize execution over bookkeeping.',
      'Load skills from repo `skills/` and `~/.agents/**/SKILL.md` only when relevant with load_skill(name).',
      'Use persistent tasks for long-lived work and teammates only for clearly separable work.',
      'For large builds: load_skill(Long-running harness) and use harness_write_spec for cross-session handoffs.',
      'Use memory_set/memory_get for scratch and long-term notes; handoff_state copies scratch to subagents.',
      'You can create bots and group chats (可以创建 bot 和群聊) with create_bot and create_room. The same actions are also available as bot_create, bot_update, bot_room_create, bot_room_update, and lab_settings_update when they are in your tool list. Do not claim you lack that ability. Deletes need confirm: true and approval. Never repeat API keys or tokens. Do not read secrets; reference a model already configured in the lab. Do not approve tool calls or outbound drafts for the user.',
      PRIVATE_CHAT_GROUP_SPEAKER_RULE,
      'When the user attaches images or you need OCR/visual detail from stored screenshots, call vision_analyze with asset_ids (from [image id] markers) and a focused prompt. Requires RAW_AGENT_VL_MODEL_NAME.',
      resolveDiscoveryEnabled(this.deps.store, process.env)
        ? 'External service discovery is enabled. It is separate from local tool delivery. Capability cards describe external bindings; they are not executable tools by themselves.'
        : '',
      toolDirectory(this.deps.store),
      harnessLines.length > 0 ? harnessLines.join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const scope = agenticSafetyAppendixScope(process.env);
    if (scope === 'off') return base;
    if (scope === 'general' && ctx.agent.id !== 'general') return base;
    return `${base}\n\n---\n\n${RUNTIME_AGENTIC_SAFETY_APPENDIX}`;
  }

  /** Build the dynamic per-turn block (todos, task, memory, skills). */
  async buildDynamicContext(ctx: PromptContext, messages: SessionMessage[]): Promise<string> {
    const profile = runProfileFromSession(ctx.session);
    const skills = filterSkillsByAllowlist(
      filterSkillsByScope(
        await this.skillsForSession(ctx.session.id),
        profile.skillScope,
        requestedSkillNames(ctx.session.metadata)
      ),
      readAllowedSkillNames(ctx.session.metadata)
    );
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = textFromMessage(lastUser ?? { parts: [], role: 'user', id: '', sessionId: '', createdAt: '' });
    const mode = skillRoutingModeFromEnv(process.env);
    const topK = skillRoutingTopKFromEnv(process.env);
    let routing = await buildSkillRoutingCooperative(userText, skills, { mode, topK });
    const shortlistCandidates = [
      ...routing.routed.map((r) => ({
        id: r.skill.id,
        ownerBotId: r.skill.ownerBotId,
        name: r.skill.name,
        description: r.skill.description
      })),
      ...routing.keywordMatched
        .filter((s) => !routing.shortlistNames.includes(s.name))
        .map((s) => ({ name: s.name, description: s.description }))
    ];
    if (shortlistCandidates.length > 0) {
      const kept = await applyJevSkillSelect(this.deps.store, userText, shortlistCandidates);
      if (kept) {
        const keep = new Set(kept);
        routing = {
          ...routing,
          routed: routing.routed.filter((r) => keep.has(r.skill.name)),
          keywordMatched: routing.keywordMatched.filter((s) => keep.has(s.name)),
          shortlistNames: routing.shortlistNames.filter((n) => keep.has(n))
        };
      }
    }
    this.routingBySession.set(ctx.session.id, routing);
    const skillBlock = buildSkillCatalogBlock(
      resolveSkillDisclosureMode({ store: this.deps.store, env: process.env }),
      skills,
      routing
    );

    const todoLine = ctx.session.todo.length > 0 ? JSON.stringify(ctx.session.todo) : 'No active todos.';
    const taskLine = ctx.task
      ? `Task: ${ctx.task.id} | ${ctx.task.title} | status=${ctx.task.status} | blockedBy=${ctx.task.blockedBy.join(', ') || 'none'}`
      : 'No bound task.';

    const cognitiveInfo = this.lastCognitivePhaseBySession.get(ctx.session.id);
    const cognitiveLine = cognitiveInfo
      ? `Session phase: ${cognitiveInfo.phase} (${(cognitiveInfo.confidence * 100).toFixed(0)}% confidence)`
      : '';

    const summaryMaxChars = compactSummaryMaxChars(process.env);
    const summaryLine = ctx.session.summary && summaryMaxChars > HISTORICAL_SUMMARY_NOTICE.length && !messages.some(message => message.key === 'compact-summary')
      ? `${HISTORICAL_SUMMARY_NOTICE}Compressed summary:\n${capRollingSummaryText(ctx.session.summary, summaryMaxChars - HISTORICAL_SUMMARY_NOTICE.length)}`
      : '';

    // Memory is intentionally NOT in the dynamic system block — see buildMemoryAppendix
    // (user-side appendix preserves provider prefix cache when memory churns).
    const savedRaw = ctx.session.metadata?.ptcOrchestration;
    const replayBlock =
      profile.orchestration === 'dynamic_workflow'
        ? buildReplayPromptBlock(
            savedRaw && typeof savedRaw === 'object'
              ? normalizeSavedOrchestration(savedRaw)
              : undefined,
            orchestrationReplayFromSession(ctx.session)
          )
        : '';
    const ptcBlock =
      isPtcSession(ctx.session) && profile.orchestrationReplay !== 'hard'
        ? buildPtcOrchestrationBlock({
            jevDecide: chainHas(resolveJevChain(this.deps.store), 'ptcDecide')
          })
        : '';
    const dynToolsBlock = buildDynToolsPromptBlock(resolveDynToolsEnabled(this.deps.store));
    return [taskLine, buildTaskContext(ctx.session, ctx.task), `Todos: ${todoLine}`, cognitiveLine, summaryLine, ptcBlock, replayBlock, dynToolsBlock, skillBlock]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Memory appendix for the *user* side of the turn (not system).
   * Four-slot compiler output; empty slots omitted. Never enters system prefix.
   */
  buildMemoryAppendix(ctx: PromptContext, opts?: { query?: string; stateDir?: string }): string {
    if (runProfileFromSession(ctx.session).persistentMemory === 'off') return '';
    return compileTurnAppendix({
      session: ctx.session,
      query: opts?.query ?? '',
      store: this.deps.store,
      stateDir: opts?.stateDir
    });
  }

  /** Turn packing path: includes optional Jev memorySelect on appendix slots. */
  async buildMemoryAppendixAsync(
    ctx: PromptContext,
    opts?: { query?: string; stateDir?: string }
  ): Promise<string> {
    if (runProfileFromSession(ctx.session).persistentMemory === 'off') return '';
    return compileTurnAppendixAsync({
      session: ctx.session,
      query: opts?.query ?? '',
      store: this.deps.store,
      stateDir: opts?.stateDir
    });
  }

  /** Full system prompt = stable prefix + dynamic context (memory excluded). */
  async buildSystemPrompt(ctx: PromptContext, messages: SessionMessage[]): Promise<string> {
    const stablePrefix = this.buildStablePrefix(ctx);
    const dynamicContext = await this.buildDynamicContext(ctx, messages);
    return [stablePrefix, dynamicContext, this.deps.runtimeInstructions?.(ctx.session.id)].filter(Boolean).join('\n\n---\n\n');
  }

  async allSkills(): Promise<SkillSpec[]> {
    if (!this.workspaceSkillsPromise) {
      this.workspaceSkillsPromise = (async () => {
        const [ws, user, ag] = await Promise.all([
          loadWorkspaceSkills(this.deps.repoRoot),
          loadStateDirSkills(this.deps.stateDir),
          loadAgentsDirSkills()
        ]);
        const fromFs = mergeSkillsByName(mergeSkillsByName(ws, user), ag);
        if (this.deps.cloudSkillsLoader) {
          const catalog = await this.deps.cloudSkillsLoader();
          return mergeSkillsByName(catalog, fromFs);
        }
        return fromFs;
      })();
    }
    const merged = await this.workspaceSkillsPromise;
    return [...builtinSkills, ...merged, ...(this.deps.extraSkills ?? [])];
  }

  /** Reset cached workspace skills (e.g. after runtime reloads them). */
  invalidateSkillsCache(): void {
    this.workspaceSkillsPromise = undefined;
  }
}
