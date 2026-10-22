/**
 * Next-input suggestion for a bot chat composer.
 * Lab UI persists the switch in daemon_control. No RAW_AGENT_* flag.
 */

import { nowIso } from '../id.js';
import type { SessionMessage } from '../types.js';

export const INPUT_SUGGESTION_SETTINGS_KEY = 'input_suggestion_settings';

export const INPUT_SUGGESTION_MAX = 3;
export const INPUT_SUGGESTION_TEXT_MAX = 200;
const CONTEXT_TURNS = 6;
const CONTEXT_CHARS = 4000;

export interface InputSuggestionSettings {
  /** When false, the composer never asks for a next input. Default on. */
  enabled: boolean;
  updatedAt: string;
}

export interface InputSuggestionSettingsPatch {
  enabled?: boolean;
}

export interface InputSuggestionSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export interface InputSuggestion {
  /** Primary guess. Ghost text shows this until Tab cycles. */
  primary: string;
  /** Extra guesses, at most two. Tab cycles primary then these. */
  alternatives: string[];
}

export interface SuggestionTurn {
  role: 'user' | 'assistant';
  text: string;
}

export function defaultInputSuggestionSettings(): InputSuggestionSettings {
  return { enabled: true, updatedAt: nowIso() };
}

export function normalizeInputSuggestionSettings(
  raw: Partial<InputSuggestionSettings> | null | undefined
): InputSuggestionSettings {
  const base = defaultInputSuggestionSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: raw.enabled === false ? false : true,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : base.updatedAt
  };
}

export function readInputSuggestionSettings(store: InputSuggestionSettingsStore): InputSuggestionSettings {
  const saved = store.getDaemonControl<Partial<InputSuggestionSettings>>(INPUT_SUGGESTION_SETTINGS_KEY);
  if (!saved) return defaultInputSuggestionSettings();
  return normalizeInputSuggestionSettings(saved);
}

export function writeInputSuggestionSettings(
  store: InputSuggestionSettingsStore,
  patch: InputSuggestionSettingsPatch
): InputSuggestionSettings {
  const current = readInputSuggestionSettings(store);
  const next = normalizeInputSuggestionSettings({
    ...current,
    ...patch,
    updatedAt: nowIso()
  });
  store.setDaemonControl(INPUT_SUGGESTION_SETTINGS_KEY, next);
  return next;
}

export function hasPersistedInputSuggestionSettings(store: InputSuggestionSettingsStore): boolean {
  return store.getDaemonControl(INPUT_SUGGESTION_SETTINGS_KEY) != null;
}

/** Ghost text is only for an empty, focused bot composer that is not mid-send. */
export function suggestionVisible(input: {
  botChat: boolean;
  draft: string;
  focused: boolean;
  busy: boolean;
  enabled: boolean;
}): boolean {
  return input.botChat && input.enabled && input.focused && !input.busy && input.draft.trim().length === 0;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= INPUT_SUGGESTION_TEXT_MAX) return flat;
  return flat.slice(0, INPUT_SUGGESTION_TEXT_MAX).trim();
}

function messageText(message: SessionMessage): string {
  let text = '';
  for (const part of message.parts) {
    if (part.type === 'text' && part.text) text += part.text;
  }
  return text.trim();
}

/** Recent user/assistant lines the generator may see. Hidden rows stay out. */
export function recentSuggestionTurns(messages: SessionMessage[], limit = CONTEXT_TURNS): SuggestionTurn[] {
  const turns: SuggestionTurn[] = [];
  for (const message of messages) {
    if (message.hidden) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = messageText(message);
    if (!text) continue;
    turns.push({ role: message.role, text: clip(text) });
  }
  return turns.slice(-limit);
}

export function suggestionPrompt(turns: SuggestionTurn[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const turn of turns) {
    const line = `${turn.role}: ${turn.text}`;
    if (used + line.length > CONTEXT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

function asLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = clip(item);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= INPUT_SUGGESTION_MAX) break;
  }
  return out;
}

/** Accepts `{ suggestions: string[] }` or `{ primary, alternatives }`. Junk becomes null. */
export function parseInputSuggestion(raw: string): InputSuggestion | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const one = clip(trimmed);
    return one ? { primary: one, alternatives: [] } : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as { suggestions?: unknown; primary?: unknown; alternatives?: unknown };
  const listed = asLines(body.suggestions);
  if (listed.length > 0) {
    return { primary: listed[0]!, alternatives: listed.slice(1) };
  }
  const primary = typeof body.primary === 'string' ? clip(body.primary) : '';
  if (!primary) return null;
  const alternatives = asLines(body.alternatives).filter((item) => item !== primary);
  return { primary, alternatives: alternatives.slice(0, INPUT_SUGGESTION_MAX - 1) };
}

const SYSTEM_PROMPT = [
  'You suggest the next thing the human might type to this bot.',
  'Use only the recent conversation. Do not invent tasks the human did not imply.',
  'Return JSON only: {"suggestions":["..."]}.',
  'One to three short lines, each a possible next user message, most likely first.',
  'No quotes, labels, or explanation outside the JSON.'
].join(' ');

export function inputSuggestionRequest(turns: SuggestionTurn[]): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: suggestionPrompt(turns) || '(empty conversation)' };
}

/**
 * Latest request wins. A late response for an older id is dropped so two
 * overlapping generations cannot paint the wrong session's guess.
 */
export function acceptSuggestionResponse<T>(input: {
  requestId: number;
  latestId: number;
  sessionId: string;
  currentSessionId: string;
  value: T;
}): T | null {
  if (input.requestId !== input.latestId) return null;
  if (input.sessionId !== input.currentSessionId) return null;
  return input.value;
}
