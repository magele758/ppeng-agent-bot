export type {
  BotRecord,
  CreateBotInput,
  ListBotsOptions,
  OpenBotResult,
  UpdateBotInput
} from './types.js';
export {
  BOT_DEFAULT_PERMISSION_MODE,
  BOT_DESCRIPTION_MAX,
  BOT_NAME_MAX,
  BOT_ROSTER_CAP,
  BOT_TITLE_MAX,
  CANONICAL_BOT_CHAT_META,
  SESSION_CUT_META
} from './types.js';
export {
  BOT_REQUIRED_TOOLS,
  botPolicyWarnings,
  botToolAllowlistWarnings,
  isMcpToolName,
  readPositiveAllowedTools,
  type BotPolicyToolContext,
  type BotPolicyWarning
} from './bot-policy.js';
export {
  BOT_MODEL_OVERRIDE_META,
  normalizeBotModelOverride,
  parseModelOverrideInput,
  readBotModelOverride
} from './bot-model.js';
export {
  BOT_AVATAR_EMOJIS,
  BOT_FACE_COLORS,
  BOT_FACE_SHAPES,
  faceUpdatePatch,
  normalizeBotAvatar,
  normalizeBotFaceColor,
  normalizeBotFaceShape,
  readBotFaceColor,
  readBotFaceShape,
  readFaceInput
} from './bot-appearance.js';
export type { BotFaceColor, BotFaceShape } from './bot-appearance.js';
export { BotStore } from './bot-store.js';
export { BotFunctionalGroupService } from './functional-groups.js';
export type { BotFunctionalGroup, BotSharedScope } from './functional-groups.js';
export {
  botInstructions,
  canonicalBotChatTitle,
  createBot,
  getBot,
  listBots,
  openBot,
  resolveBotIdFromBody,
  slugifyBotName,
  updateBot
} from './bot-facade.js';
export {
  applyBotChatCommand,
  canonicalBotIdFromSession,
  parseBotChatCommand,
  resolveBotModelArg
} from './bot-chat-commands.js';
export type {
  BotChatCommandCode,
  BotChatCommandHost,
  BotChatCommandResult,
  ParsedBotChatCommand
} from './bot-chat-commands.js';

export * from './bot-identity.js';
export * from './bot-work.js';
export {
  assembleBotActivity,
  botActivityStatus,
  listSessionBotActivity
} from './bot-activity.js';
export type {
  AssembleBotActivityInput,
  BotActivityItem,
  BotActivityKind,
  BotActivityStatus
} from './bot-activity.js';
