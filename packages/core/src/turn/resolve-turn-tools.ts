/**
 * Per-turn tool allowlist: external-AI gate, agent/session whitelist, optional groups.
 */

import { envBool } from '../env.js';
import {
  assertToolsetInvariant,
  promptCacheStrictFromEnv
} from '../session/prompt-cache.js';
import {
  filterToolsByOptionalGroups,
  loadOptionalToolGroupsFromEnv,
  mergeEnabledOptionalToolGroups,
  optionalToolGroupsFeatureEnabled,
  parseDefaultEnabledOptionalGroups
} from '../tools/optional-tool-groups.js';
import type { AgentSpec, SessionRecord, ToolContract } from '../types.js';
import {
  applyRunProfileToTools,
  runProfileFromSession,
  sealTaskRunModePatch
} from '../runtime/run-profile.js';
import { sealWorkspaceBindingPatch, workspaceBindingFromMetadata } from '../workspace/index.js';
import {
  resolveWebSearchTemplate,
  type WebSettingsReadStore
} from '../tools/web-settings.js';
import { DYN_META_TOOL_NAMES, SEARCH_DYN_TOOLS_NAME } from '../dyn-tools/types.js';
import { readDynToolSettings } from '../dyn-tools/settings.js';
import { tryCreateDynToolStore } from '../dyn-tools/store.js';
import { isPtcSession } from '../ptc/mode.js';
import { readSkillProposalSettings } from '../skill-proposals/settings.js';
import { SKILL_PROPOSE_TOOL_NAME } from '../skill-proposals/tool.js';
import { stripSubagentDeniedTools } from '../runtime/subagent-policy.js';
import {
  isCanonicalBotChatSession,
  MESSAGE_AGENT_TOOL_NAME
} from '../tools/message-agent.js';

function searchDynToolsNeeded(
  settingsStore: WebSettingsReadStore | undefined,
  sessionId: string,
  settings: ReturnType<typeof readDynToolSettings>
): boolean {
  if (!settings.enabled || !settingsStore) return false;
  const dyn = tryCreateDynToolStore(settingsStore as Parameters<typeof tryCreateDynToolStore>[0]);
  if (!dyn) return false;
  return dyn.listActive(sessionId).length > settings.hydrateTopK;
}

/**
 * Agent and session allowlists. A non-empty list is exclusive, so it also has to gate
 * tools that are not in the static catalog (MCP expansions, PTC dynamic tools).
 */
function allowlistsFor(agent: AgentSpec, session: SessionRecord): ReadonlySet<string>[] {
  const lists: ReadonlySet<string>[] = [];
  if (agent.allowedTools && agent.allowedTools.length > 0) {
    lists.push(new Set(agent.allowedTools));
  }
  const metaAllowed = session.metadata?.allowedTools;
  if (Array.isArray(metaAllowed) && metaAllowed.length > 0) {
    lists.push(new Set(metaAllowed.map((n) => String(n))));
  }
  return lists;
}

function applyAllowlists<T extends { name: string }>(
  tools: readonly T[],
  lists: readonly ReadonlySet<string>[]
): T[] {
  return tools.filter((t) => lists.every((allow) => allow.has(t.name)));
}

export function filterToolsForSession(input: {
  env: NodeJS.ProcessEnv;
  tools: ToolContract<any>[];
  agent: AgentSpec;
  session: SessionRecord;
  settingsStore?: WebSettingsReadStore;
}): { allowExternalAiTools: boolean; tools: ToolContract<any>[] } {
  const externalAiCapabilityGate = envBool(input.env, 'RAW_AGENT_EXTERNAL_AI_TOOLS', false);
  const sessionOptIn = input.session.metadata?.allowExternalAiTools === true;
  const allowExternalAiTools = externalAiCapabilityGate && sessionOptIn;
  const externallyGated = allowExternalAiTools
    ? input.tools
    : input.tools.filter((t) => !t.isExternal);
  let tools = applyAllowlists(externallyGated, allowlistsFor(input.agent, input.session));

  const assembled = tools;

  const hasExplicitOptionalToolSelection =
    input.session.metadata &&
    Object.prototype.hasOwnProperty.call(input.session.metadata, 'enabledOptionalToolGroups');
  const defaultOptionalGroups = parseDefaultEnabledOptionalGroups(input.env);
  if (
    optionalToolGroupsFeatureEnabled(input.env) &&
    (hasExplicitOptionalToolSelection || defaultOptionalGroups.length > 0)
  ) {
    const groups = loadOptionalToolGroupsFromEnv(input.env);
    const clientEnabled = hasExplicitOptionalToolSelection
      ? input.session.metadata?.enabledOptionalToolGroups
      : [];
    const enabled = mergeEnabledOptionalToolGroups(defaultOptionalGroups, clientEnabled);
    tools = filterToolsByOptionalGroups(tools, enabled, groups).tools;
  }

  const profile = runProfileFromSession(input.session);
  tools = applyRunProfileToTools(tools, profile, assembled);
  if (!resolveWebSearchTemplate(input.settingsStore, input.env)) {
    tools = tools.filter((t) => t.name !== 'web_search');
  }

  const dynSettings = readDynToolSettings(input.settingsStore);
  const meta = new Set<string>(DYN_META_TOOL_NAMES);
  if (!dynSettings.enabled) {
    tools = tools.filter((t) => !meta.has(t.name));
  } else {
    const allowSave = dynSettings.allowSave || isPtcSession(input.session);
    const needSearch = searchDynToolsNeeded(input.settingsStore, input.session.id, dynSettings);
    const have = new Set(tools.map((t) => t.name));
    for (const t of assembled) {
      if (!meta.has(t.name) || have.has(t.name)) continue;
      if (t.name === 'save_as_tool' && !allowSave) continue;
      if (t.name === 'propose_tool' && !dynSettings.allowPropose) continue;
      if (t.name === SEARCH_DYN_TOOLS_NAME && !needSearch) continue;
      tools.push(t);
      have.add(t.name);
    }
    if (!allowSave) {
      tools = tools.filter((t) => t.name !== 'save_as_tool');
    }
    if (!dynSettings.allowPropose) {
      tools = tools.filter((t) => t.name !== 'propose_tool');
    }
    if (!needSearch) {
      tools = tools.filter((t) => t.name !== SEARCH_DYN_TOOLS_NAME);
    }
  }
  if (!readSkillProposalSettings(input.settingsStore).enabled) {
    tools = tools.filter((t) => t.name !== SKILL_PROPOSE_TOOL_NAME);
  }
  if (!isCanonicalBotChatSession(input.session)) {
    tools = tools.filter((t) => t.name !== MESSAGE_AGENT_TOOL_NAME);
  }
  return { allowExternalAiTools, tools: stripSubagentDeniedTools(input.session, tools) };
}

export function resolveTurnTools(input: {
  env: NodeJS.ProcessEnv;
  tools: ToolContract<any>[];
  agent: AgentSpec;
  session: SessionRecord;
  sessionId: string;
  systemPromptChars: number;
  settingsStore?: WebSettingsReadStore;
  /** Harvested ptc_cell tools for this turn (already materialized). */
  dynTools?: ToolContract<any>[];
}): {
  allowExternalAiTools: boolean;
  turnTools: ToolContract<any>[];
  turnShape: { systemPromptChars: number; toolCount: number };
  metadataPatch: Record<string, unknown>;
  drifted: boolean;
  fingerprint?: string;
  promptCacheKey: string;
} {
  const filtered = filterToolsForSession(input);
  const allowExternalAiTools = filtered.allowExternalAiTools;
  const names = new Set(filtered.tools.map((t) => t.name));
  const extras: ToolContract<any>[] = [];
  const dynAllowed = applyAllowlists(
    input.dynTools ?? [],
    allowlistsFor(input.agent, input.session)
  );
  for (const tool of dynAllowed) {
    if (names.has(tool.name)) continue;
    extras.push(tool);
    names.add(tool.name);
  }
  const merged = extras.length > 0 ? [...filtered.tools, ...extras] : filtered.tools;
  const turnTools = stripSubagentDeniedTools(
    input.session,
    isCanonicalBotChatSession(input.session)
      ? merged
      : merged.filter((t) => t.name !== MESSAGE_AGENT_TOOL_NAME)
  );
  const profile = runProfileFromSession(input.session);
  const bindPatch = sealTaskRunModePatch(input.session.metadata, profile.mode);
  const workspaceSeal = sealWorkspaceBindingPatch(
    input.session.metadata,
    workspaceBindingFromMetadata(input.session.metadata)
  );

  const toolsetLock = assertToolsetInvariant(
    input.sessionId,
    turnTools.map((t) => t.name),
    input.session.metadata,
    { strict: promptCacheStrictFromEnv(input.env) }
  );

  return {
    allowExternalAiTools,
    turnTools,
    turnShape: {
      systemPromptChars: input.systemPromptChars,
      toolCount: turnTools.length
    },
    metadataPatch: { ...toolsetLock.metadataPatch, ...bindPatch, ...workspaceSeal },
    drifted: toolsetLock.drifted,
    fingerprint: toolsetLock.fingerprint,
    promptCacheKey: toolsetLock.promptCacheKey
  };
}
