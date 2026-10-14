/**
 * Memory, pause, and software-connection panels stay mounted when the selected
 * bot changes. Rows and drafts stay tied to the bot that loaded them. A read
 * for any other bot is dropped, including one that finishes late or is already
 * cancelled, so it cannot replace the bot on screen.
 */

export function shownRows<T>(selectedBotId: string, loadedBotId: string, rows: readonly T[]): readonly T[] {
  return selectedBotId === loadedBotId ? rows : [];
}

export function ownedByBot<T>(selectedBotId: string, ownerBotId: string, value: T | null): T | null {
  return selectedBotId === ownerBotId ? value : null;
}

export type PauseControl = { paused: boolean; disabled: boolean };

export function shownPause(selectedBotId: string, loadedBotId: string, control: PauseControl): PauseControl {
  return selectedBotId === loadedBotId ? control : { paused: false, disabled: false };
}

export function pauseChange(args: {
  selectedBotId: string;
  loadedBotId: string;
  control: PauseControl;
  paused?: boolean;
  disabled?: boolean;
}): { botId: string; control: PauseControl } | null {
  if (args.selectedBotId !== args.loadedBotId) return null;
  if (args.paused == null && args.disabled == null) return null;
  return {
    botId: args.selectedBotId,
    control: {
      paused: args.paused ?? args.control.paused,
      disabled: args.disabled ?? args.control.disabled
    }
  };
}

export function startBotRead(args: {
  selectedBotId: string;
  requestedBotId: string;
  begin: () => number;
}): number | null {
  if (args.requestedBotId !== args.selectedBotId) return null;
  return args.begin();
}

export function takeBotPayload<T>(args: {
  selectedBotId: string;
  requestedBotId: string;
  generation: number;
  isCurrent: (generation: number) => boolean;
  aborted?: boolean;
  payload: T;
}): T | null {
  if (args.aborted || args.requestedBotId !== args.selectedBotId || !args.isCurrent(args.generation)) return null;
  return args.payload;
}

function readWasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function readBotPanel<T>(args: {
  selectedBotId: () => string;
  requestedBotId: string;
  begin: () => number;
  isCurrent: (generation: number) => boolean;
  signal?: AbortSignal;
  read: () => Promise<T>;
}): Promise<T | null> {
  if (readWasAborted(args.signal)) return null;
  const generation = startBotRead({
    selectedBotId: args.selectedBotId(),
    requestedBotId: args.requestedBotId,
    begin: args.begin
  });
  if (generation == null) return null;
  try {
    const payload = await args.read();
    return takeBotPayload({
      selectedBotId: args.selectedBotId(),
      requestedBotId: args.requestedBotId,
      generation,
      isCurrent: args.isCurrent,
      aborted: readWasAborted(args.signal),
      payload
    });
  } catch (error) {
    const stillCurrent = takeBotPayload({
      selectedBotId: args.selectedBotId(),
      requestedBotId: args.requestedBotId,
      generation,
      isCurrent: args.isCurrent,
      aborted: readWasAborted(args.signal),
      payload: error
    });
    if (stillCurrent == null) return null;
    throw error;
  }
}
