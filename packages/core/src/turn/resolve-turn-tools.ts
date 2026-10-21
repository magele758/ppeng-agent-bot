import { filterFactoryTools } from '../factory/tool-policy.js';
import { filterRoomTools } from '../rooms/tool-policy.js';
import { ROOM_RETRIEVAL_TOOL_NAMES } from '../rooms/room-retrieval-tools.js';
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
import { readDisclosedToolNames, splitDeferredTools } from '../tools/deferred-disclosure.js';
import { DYN_META_TOOL_NAMES, SEARCH_DYN_TOOLS_NAME } from '../dyn-tools/types.js';
import { readDynToolSettings } from '../dyn-tools/settings.js';
import { tryCreateDynToolStore } from '../dyn-tools/store.js';
import { isPtcSession } from '../ptc/mode.js';
import { readSkillProposalSettings } from '../skill-proposals/settings.js';
import { APP_CONTROL_TOOL_NAMES, readAppControlSettings } from '../app-control/settings.js';
import { SKILL_PROPOSE_TOOL_NAME } from '../skill-proposals/tool.js';
import { stripSubagentDeniedTools } from '../runtime/subagent-policy.js';
import { ASK_BOT_HELP_TOOL } from '../runtime/subagent-help.js';
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
    const names = metaAllowed.map((n) => String(n));
    if (isRoomMemberSession(session)) {
      for (const name of ROOM_RETRIEVAL_TOOL_NAMES) {
        if (!names.includes(name)) names.push(name);
      }
    }
    lists.push(new Set(names));
  }
  return lists;
}

function applyAllowlists<T extends { name: string }>(
  tools: readonly T[],
  lists: readonly ReadonlySet<string>[]
): T[] {
  return tools.filter((t) => lists.every((allow) => allow.has(t.name)));
}

function authorizeToolsForSession(input: {
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
  if ((input.settingsStore?.getDaemonControl?.('computer_use_settings') as { enabled?: boolean } | undefined)?.enabled !== true) {
    tools = tools.filter(tool => !tool.name.startsWith('lcu_'));
  }
  if (!readAppControlSettings(input.settingsStore).enabled) {
    const hidden = new Set<string>(APP_CONTROL_TOOL_NAMES);
    tools = tools.filter((tool) => !hidden.has(tool.name));
  }

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
  if (!isCanonicalBotChatSession(input.session) && !isRoomMemberSession(input.session)) {
    tools = tools.filter((t) => t.name !== MESSAGE_AGENT_TOOL_NAME);
  }
  tools = withSubagentHelp(input.session, tools, input.tools);
  if (!isRoomMemberSession(input.session)) {
    const roomOnly = new Set<string>(ROOM_RETRIEVAL_TOOL_NAMES);
    tools = tools.filter((tool) => !roomOnly.has(tool.name));
  }
  return { allowExternalAiTools, tools: filterFactoryTools(input.session, filterRoomTools(input.session, stripSubagentDeniedTools(input.session, tools)), input.settingsStore) };
}

function partitionDeferred(
  agent: AgentSpec,
  session: SessionRecord,
  tools: readonly ToolContract<any>[]
) {
  return splitDeferredTools({
    tools,
    agentAllowedTools: agent.allowedTools,
    disclosedNames: readDisclosedToolNames(session.metadata)
  });
}

export function filterToolsForSession(input: {
  env: NodeJS.ProcessEnv;
  tools: ToolContract<any>[];
  agent: AgentSpec;
  session: SessionRecord;
  settingsStore?: WebSettingsReadStore;
}): { allowExternalAiTools: boolean; tools: ToolContract<any>[] } {
  const authorized = authorizeToolsForSession(input);
  return {
    allowExternalAiTools: authorized.allowExternalAiTools,
    tools: partitionDeferred(input.agent, input.session, authorized.tools).visible
  };
}

/** On-demand tools that passed authorization and are withheld from this turn. */
export function hiddenDeferredToolsForSession(input: {
  env: NodeJS.ProcessEnv;
  tools: ToolContract<any>[];
  agent: AgentSpec;
  session: SessionRecord;
  settingsStore?: WebSettingsReadStore;
}): ToolContract<any>[] {
  const authorized = authorizeToolsForSession(input);
  return partitionDeferred(input.agent, input.session, authorized.tools).hidden;
}

/** A Room member turn is the only non-canonical session allowed to call message_agent. */
function isRoomMemberSession(session: { metadata?: Record<string, unknown> | null }): boolean {
  return typeof session.metadata?.roomId === 'string' && session.metadata.roomId.trim().length > 0;
}

function withSubagentHelp<T extends { name: string }>(
  session: { mode?: string },
  tools: T[],
  catalog: readonly T[]
): T[] {
  if (session.mode === 'subagent') {
    if (tools.some((tool) => tool.name === ASK_BOT_HELP_TOOL)) return tools;
    const tool = catalog.find((item) => item.name === ASK_BOT_HELP_TOOL);
    return tool ? [...tools, tool] : tools;
  }
  return tools.filter((tool) => tool.name !== ASK_BOT_HELP_TOOL);
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
  const turnTools = filterFactoryTools(input.session, filterRoomTools(input.session, stripSubagentDeniedTools(
    input.session,
    isCanonicalBotChatSession(input.session) || isRoomMemberSession(input.session)
      ? merged
      : merged.filter((t) => t.name !== MESSAGE_AGENT_TOOL_NAME)
  )), input.settingsStore);
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
