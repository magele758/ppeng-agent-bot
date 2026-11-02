import { preferenceStorage } from './user-preference-storage.ts';
/**
 * Instant local feedback when the user commits a chat send (optimistic turn).
 * Mirrors the "show the elevator letter immediately" idea: a sub‑50ms tone can
 * re-anchor attention before network / stream work finishes.
 */

export const SEND_ACK_SOUND_STORAGE_KEY = 'agentLab.sendAckSound';

export function readSendAckSoundEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return preferenceStorage.getItem(SEND_ACK_SOUND_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSendAckSoundEnabled(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (on) preferenceStorage.setItem(SEND_ACK_SOUND_STORAGE_KEY, '1');
    else preferenceStorage.removeItem(SEND_ACK_SOUND_STORAGE_KEY);
  } catch {
    // quota / private mode
  }
}

let sharedCtx: AudioContext | null = null;

/** Soft tick; no-op unless {@link readSendAckSoundEnabled} and motion prefs allow. */
export function playSendAckToneIfEnabled(): void {
  if (typeof window === 'undefined') return;
  if (!readSendAckSoundEnabled()) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch {
    // matchMedia unavailable
  }

  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!sharedCtx || sharedCtx.state === 'closed') {
      sharedCtx = new AC();
    }
    const ctx = sharedCtx;
    if (ctx.state === 'suspended') void ctx.resume();

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(720, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.048);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.055);
  } catch {
    // autopolicy / missing API
  }
}
