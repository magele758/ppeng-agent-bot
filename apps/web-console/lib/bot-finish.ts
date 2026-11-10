export interface BotFinishSettings {
  followupAttachEnabled: boolean;
  followupWindowHours: number;
  finishCheckEnabled: boolean;
  maxContinuations: number;
  wakeEnabled: boolean;
  wakeDelayMinutes: number;
  maxWakes: number;
}

export type BotFinishNumberKey = 'followupWindowHours' | 'maxContinuations' | 'wakeDelayMinutes' | 'maxWakes';

/** Values offered in the Lab. The API accepts any whole number inside its range. */
export const BOT_FINISH_CHOICES: Record<BotFinishNumberKey, readonly number[]> = {
  followupWindowHours: [6, 24, 72, 168],
  maxContinuations: [1, 2, 3, 5],
  wakeDelayMinutes: [5, 10, 30, 60, 120],
  maxWakes: [1, 2, 3, 5, 10]
};

/** Offered values plus the saved one, so a value set through the API still shows as selected. */
export function botFinishOptions(key: BotFinishNumberKey, current: number): Array<{ value: string; label: string }> {
  const values = new Set([...BOT_FINISH_CHOICES[key], current]);
  return [...values].sort((a, b) => a - b).map((value) => ({ value: String(value), label: String(value) }));
}
