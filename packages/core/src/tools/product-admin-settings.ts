/**
 * Lab settings the chat bot can read and patch through the same writers the
 * console uses. Secret fields are write-only; reads go through public views.
 */

import { ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import { writeAppControlSettings, readAppControlSettings } from '../app-control/settings.js';
import { readLcuSettings, writeLcuSettings } from '../computer-use/settings.js';
import { routineSettings } from '../cron/routine-runtime.js';
import { readDiscoverySettings, writeDiscoverySettings } from '../discovery/settings.js';
import { readDynToolSettings, writeDynToolSettings } from '../dyn-tools/settings.js';
import { readGoalSettings, writeGoalSettings } from '../goal/settings.js';
import { readIngestionSettings, writeIngestionSettings } from '../ingestion/settings.js';
import { publicJevSettings, readJevSettings, writeJevSettings } from '../jev/settings.js';
import { publicLangfuseSettings, readLangfuseSettings, writeLangfuseSettings } from '../langfuse/settings.js';
import { parseCuratorMode, readMemorySettings, writeMemorySettings } from '../memory/memory-settings.js';
import { readModelFallbackSettings, writeModelFallbackSettings } from '../model/fallback-chain.js';
import { readSandboxSettings, writeSandboxSettings } from '../sandbox/sandbox-settings.js';
import { readCompactSettings, writeCompactSettings } from '../session/compact-settings.js';
import { readBotContextSettings, writeBotContextSettings } from '../session/history/window.js';
import { readSkillProposalSettings, writeSkillProposalSettings } from '../skill-proposals/settings.js';
import { readSkillSettings, writeSkillSettings } from '../skills/skill-settings.js';
import { readTeamsDagSettings, writeTeamsDagSettings } from '../teams/settings.js';
import { readBrowserSettings, writeBrowserSettings } from './browser-settings.js';
import { readWebSettings, writeWebSettings } from './web-settings.js';
import { botWorkSettings, updateBotWorkSettings } from '../bots/bot-work.js';

export interface SettingsArea {
  area: string;
  description: string;
  fields: string[];
  secrets?: 'write-only';
}

type Patch = Record<string, any>;
type Handler = {
  info: SettingsArea;
  read: (store: SqliteStateStore) => unknown;
  write: (store: SqliteStateStore, patch: Patch) => unknown;
};

const HANDLERS: Record<string, Handler> = {
  memory: {
    info: {
      area: 'memory',
      description: 'Memory curator and recall',
      fields: ['curatorMode', 'dialogueExtract', 'dreamerEnabled', 'compilerEnabled', 'embeddingRecallMode', 'minTaskTools']
    },
    read: (store) => readMemorySettings(store),
    write: (store, patch) => {
      if ('curatorMode' in patch && !parseCuratorMode(patch.curatorMode)) {
        throw new ValidationError('curatorMode must be inline, observe_only, or off');
      }
      return writeMemorySettings(store, patch);
    }
  },
  sandbox: {
    info: {
      area: 'sandbox',
      description: 'Sandbox mode. cfTokenSecretName is a vault entry name, not the token value',
      fields: ['mode', 'cfEndpoint', 'cfWorkspaceName', 'cfAccountId', 'cfTimeoutMs', 'cfBackend', 'cfTokenSecretName']
    },
    read: (store) => readSandboxSettings(store),
    write: (store, patch) => writeSandboxSettings(store, patch)
  },
  compact: {
    info: { area: 'compact', description: 'Tool-result micro-compact policy', fields: ['policy', 'keepRecent'] },
    read: (store) => readCompactSettings(store),
    write: (store, patch) => writeCompactSettings(store, patch)
  },
  skills: {
    info: { area: 'skills', description: 'Skill catalog disclosure', fields: ['disclosureMode'] },
    read: (store) => readSkillSettings(store),
    write: (store, patch) => writeSkillSettings(store, patch)
  },
  'skill-proposals': {
    info: { area: 'skill-proposals', description: 'Skill proposal master switch', fields: ['enabled', 'remindEveryNToolCalls'] },
    read: (store) => readSkillProposalSettings(store),
    write: (store, patch) => writeSkillProposalSettings(store, patch)
  },
  discovery: {
    info: {
      area: 'discovery',
      description: 'Capability discovery. Leave activeScanEnabled false unless the user explicitly asks',
      fields: ['enabled', 'tailscaleEnabled', 'activeScanEnabled', 'hostAllowlist', 'cidrAllowlist', 'statusJsonPath']
    },
    read: (store) => readDiscoverySettings(store),
    write: (store, patch) => writeDiscoverySettings(store, patch)
  },
  browser: {
    info: { area: 'browser', description: 'Browser tool switch', fields: ['enabled'] },
    read: (store) => readBrowserSettings(store),
    write: (store, patch) => writeBrowserSettings(store, patch)
  },
  web: {
    info: { area: 'web', description: 'Web search URL template; must contain {query} when set', fields: ['searchUrl'] },
    read: (store) => readWebSettings(store),
    write: (store, patch) => writeWebSettings(store, patch)
  },
  ingestion: {
    info: {
      area: 'ingestion',
      description: 'Attachment ingestion limits',
      fields: ['enabled', 'maxBytes', 'inlineTextMaxBytes', 'archivePreviewChars', 'pageSizeChars', 'gbkFallback', 'toolResultArchiveChars']
    },
    read: (store) => readIngestionSettings(store),
    write: (store, patch) => writeIngestionSettings(store, patch)
  },
  'dyn-tools': {
    info: {
      area: 'dyn-tools',
      description: 'Dynamic tool factory',
      fields: ['enabled', 'allowPropose', 'allowSave', 'allowProjectPromote', 'hydrateTopK', 'unusedSuggestTurns']
    },
    read: (store) => readDynToolSettings(store),
    write: (store, patch) => writeDynToolSettings(store, patch)
  },
  'app-control': {
    info: { area: 'app-control', description: 'macOS app control switch', fields: ['enabled'] },
    read: (store) => readAppControlSettings(store),
    write: (store, patch) => writeAppControlSettings(store, patch)
  },
  'computer-use': {
    info: { area: 'computer-use', description: 'Computer-use switch and absolute command path', fields: ['enabled', 'command'] },
    read: (store) => readLcuSettings(store),
    write: (store, patch) => writeLcuSettings(store, patch)
  },
  jev: {
    info: {
      area: 'jev',
      description: 'Jev model route. apiKey is write-only',
      fields: ['baseUrl', 'model', 'profile', 'enabled', 'apiKey', 'clearApiKey', 'points'],
      secrets: 'write-only'
    },
    read: (store) => publicJevSettings(readJevSettings(store), process.env),
    write: (store, patch) => publicJevSettings(writeJevSettings(store, patch), process.env)
  },
  langfuse: {
    info: {
      area: 'langfuse',
      description: 'Langfuse tracing. publicKey and secretKey are write-only',
      fields: ['baseUrl', 'enabled', 'publicKey', 'secretKey', 'clearPublicKey', 'clearSecretKey'],
      secrets: 'write-only'
    },
    read: (store) => publicLangfuseSettings(readLangfuseSettings(store), process.env),
    write: (store, patch) => publicLangfuseSettings(writeLangfuseSettings(store, patch), process.env)
  },
  goals: {
    info: { area: 'goals', description: 'Goal gate settings', fields: ['enabled', 'entityEnabled', 'defaultMaxTurns'] },
    read: (store) => readGoalSettings(store),
    write: (store, patch) => writeGoalSettings(store, patch)
  },
  'model-fallback': {
    info: { area: 'model-fallback', description: 'Fallback model chain of {providerId, modelId}', fields: ['chain'] },
    read: (store) => readModelFallbackSettings(store),
    write: (store, patch) => writeModelFallbackSettings(store, patch, process.env)
  },
  'bot-context': {
    info: { area: 'bot-context', description: 'Fallback context window in tokens', fields: ['fallbackContextTokens'] },
    read: (store) => readBotContextSettings(store),
    write: (store, patch) => writeBotContextSettings(store, patch)
  },
  'bot-work': {
    info: { area: 'bot-work', description: 'Delegation queue limits', fields: ['perBot', 'perPrincipal'] },
    read: (store) => botWorkSettings(store),
    write: (store, patch) => {
      const current = botWorkSettings(store);
      const perBot = typeof patch.perBot === 'number' ? patch.perBot : current.perBot;
      const perPrincipal = typeof patch.perPrincipal === 'number' ? patch.perPrincipal : current.perPrincipal;
      return updateBotWorkSettings(store, { perBot, perPrincipal });
    }
  },
  routines: {
    info: { area: 'routines', description: 'Show cron tools in bot chats', fields: ['dialogToolsEnabled'] },
    read: (store) => routineSettings(store),
    write: (store, patch) => {
      if (typeof patch.dialogToolsEnabled !== 'boolean') {
        throw new ValidationError('dialogToolsEnabled must be boolean');
      }
      return routineSettings(store, { dialogToolsEnabled: patch.dialogToolsEnabled });
    }
  },
  teams: {
    info: {
      area: 'teams',
      description: 'Team DAG planner settings',
      fields: ['enabled', 'maxConcurrent', 'workspaceSyncMode', 'usePlannerLlm', 'requireReview', 'gates']
    },
    read: (store) => readTeamsDagSettings(store),
    write: (store, patch) => writeTeamsDagSettings(store, patch)
  }
};

export function listSettingsAreas(): SettingsArea[] {
  return Object.values(HANDLERS).map((handler) => handler.info);
}

export function readSettingsArea(store: SqliteStateStore, area: string): { area: string; settings: unknown } {
  const handler = HANDLERS[area];
  if (!handler) throw new ValidationError(`Unknown settings area: ${area}`);
  return { area, settings: handler.read(store) };
}

export function writeSettingsArea(
  store: SqliteStateStore,
  area: string,
  patch: unknown
): { area: string; settings: unknown } {
  const handler = HANDLERS[area];
  if (!handler) throw new ValidationError(`Unknown settings area: ${area}`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new ValidationError('patch object is required');
  }
  return { area, settings: handler.write(store, patch as Patch) };
}
