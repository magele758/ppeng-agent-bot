import type { GoalStore } from './types.js';

/** How the runtime follows a Bot turn through to the end. Saved from the Lab; no environment variable. */
export interface BotFinishSettings {
  /** Attach "continue" and progress follow-ups to the recent unfinished goal of the chat. */
  followupAttachEnabled: boolean;
  /** A goal untouched for longer than this is not picked up by a bare follow-up. */
  followupWindowHours: number;
  /** Check a goal-less turn before it ends and send it back to work when it stopped early. */
  finishCheckEnabled: boolean;
  /** How many times one turn may be sent back to work. */
  maxContinuations: number;
  /** Register a wake when the Bot promises to report later without any wait in place. */
  wakeEnabled: boolean;
  /** Delay before the first wake. Each later wake doubles it. */
  wakeDelayMinutes: number;
  /** Wakes allowed for one promise before the runtime stops checking. */
  maxWakes: number;
}

const KEY = 'bot_finish_settings';

export const DEFAULT_BOT_FINISH_SETTINGS: BotFinishSettings = {
  followupAttachEnabled: true,
  followupWindowHours: 24,
  finishCheckEnabled: true,
  maxContinuations: 2,
  wakeEnabled: true,
  wakeDelayMinutes: 10,
  maxWakes: 3,
};

const RANGES: Record<'followupWindowHours' | 'maxContinuations' | 'wakeDelayMinutes' | 'maxWakes', [number, number]> = {
  followupWindowHours: [1, 168],
  maxContinuations: [1, 5],
  wakeDelayMinutes: [1, 720],
  maxWakes: [1, 10],
};
const FLAGS = ['followupAttachEnabled', 'finishCheckEnabled', 'wakeEnabled'] as const;

export function readBotFinishSettings(store: Pick<GoalStore, 'getDaemonControl'>): BotFinishSettings {
  return { ...DEFAULT_BOT_FINISH_SETTINGS, ...store.getDaemonControl<Partial<BotFinishSettings>>(KEY) };
}

function assertFlags(next: BotFinishSettings): void {
  for (const key of FLAGS) {
    if (typeof next[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  }
}

function assertRanges(next: BotFinishSettings): void {
  for (const [key, [min, max]] of Object.entries(RANGES) as Array<[keyof typeof RANGES, [number, number]]>) {
    const value = next[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected ${min}-${max}`);
  }
}

export function writeBotFinishSettings(store: GoalStore, patch: Partial<BotFinishSettings>): BotFinishSettings {
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULT_BOT_FINISH_SETTINGS)) throw new Error(`Unknown setting ${key}`);
  }
  const next = { ...readBotFinishSettings(store), ...patch };
  assertFlags(next);
  assertRanges(next);
  store.setDaemonControl(KEY, next);
  return next;
}
