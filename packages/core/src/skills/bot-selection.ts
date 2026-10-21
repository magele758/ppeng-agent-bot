import type { SkillSpec } from "../types.js";
import type { SkillProposalSettingsStore } from "../skill-proposals/settings.js";
export interface BotSkillSelection {
  mode: "all" | "selected";
  ids: string[];
}
export const botSkillSelectionKey = (bot: string) =>
  `bot_skill_selection:${bot}`;
export function readBotSkillSelection(
  store: SkillProposalSettingsStore,
  bot?: string,
): BotSkillSelection {
  const raw = (
    bot ? store.getDaemonControl?.(botSkillSelectionKey(bot)) : undefined
  ) as BotSkillSelection | undefined;
  return raw?.mode === "selected"
    ? { mode: "selected", ids: Array.isArray(raw.ids) ? raw.ids : [] }
    : { mode: "all", ids: [] };
}
export function selectBotSkills(
  skills: SkillSpec[],
  selection: BotSkillSelection,
) {
  return selection.mode === "all"
    ? skills
    : skills.filter((s) => selection.ids.includes(s.id));
}
