/**
 * Fixed AppleScript templates for the host. Tool arguments are data, never
 * concatenated into these strings.
 */

import { isAppControlToolName } from './settings.js';

export const APP_CONTROL_KEYS = [
  'return',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'cmd-c',
  'cmd-v'
] as const;

export type AppControlKey = (typeof APP_CONTROL_KEYS)[number];

const ACTIVATE_SCRIPT = `on run argv
  if (count of argv) is not 1 then error "expected one application name"
  tell application (item 1 of argv) to activate
end run`;

const TYPE_SCRIPT = `on run argv
  if (count of argv) is not 1 then error "expected one text value"
  tell application "System Events" to keystroke (item 1 of argv)
end run`;

const KEY_SCRIPTS: Record<AppControlKey, string> = {
  return: 'tell application "System Events" to key code 36',
  tab: 'tell application "System Events" to key code 48',
  escape: 'tell application "System Events" to key code 53',
  left: 'tell application "System Events" to key code 123',
  right: 'tell application "System Events" to key code 124',
  down: 'tell application "System Events" to key code 125',
  up: 'tell application "System Events" to key code 126',
  'cmd-c': 'tell application "System Events" to keystroke "c" using command down',
  'cmd-v': 'tell application "System Events" to keystroke "v" using command down'
};

export const APP_CONTROL_SCRIPTS = {
  activate: ACTIVATE_SCRIPT,
  typeText: TYPE_SCRIPT,
  keys: KEY_SCRIPTS
} as const;

export const APP_CONTROL_REJECTED =
  'Rejected: the argument looks like a raw script, do shell script, or a URL scheme. No command was started.';

const APP_CONTROL_PLAIN =
  'Rejected: only a plain application name or plain text is accepted. No command was started.';

const APP_CONTROL_KEY =
  'Rejected: keystroke must be one of return, tab, escape, up, down, left, right, cmd-c, cmd-v. No command was started.';

const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+&'()-]{0,63}$/u;

export type AppControlPlan =
  | { ok: true; script: string; extraArgs: string[] }
  | { ok: false; content: string };

export function looksLikeScript(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value)
    || /\bdo\s+shell\s+script\b/i.test(value)
    || /\bosascript\b/i.test(value)
    || /\btell\s+(?:application|app|process)\b/i.test(value)
    || /\brun\s+script\b/i.test(value)
    || value.includes('`')
    || value.includes('$(');
}

export function looksLikeUrlScheme(value: string): boolean {
  return /[a-z][a-z0-9+.-]*:\s*\/\//i.test(value)
    || /\bopen\s+location\b/i.test(value)
    || /(?:^|[\s"'`(])(?:javascript|data|file|cursor|vscode|vscode-insiders|slack|mailto|tel|sms|facetime|message)\s*:/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsInjection(value: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  if (typeof value === 'string') return looksLikeScript(value) || looksLikeUrlScheme(value);
  if (Array.isArray(value)) return value.some((item) => containsInjection(item, depth + 1));
  if (isRecord(value)) return Object.values(value).some((item) => containsInjection(item, depth + 1));
  return false;
}

function onlyKeys(args: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(args);
  return keys.length === allowed.length && allowed.every((key) => keys.includes(key));
}

function planActivate(args: Record<string, unknown>): AppControlPlan {
  if (!onlyKeys(args, ['app']) || typeof args.app !== 'string' || !APP_NAME.test(args.app)) {
    return { ok: false, content: APP_CONTROL_PLAIN };
  }
  return { ok: true, script: ACTIVATE_SCRIPT, extraArgs: [args.app] };
}

function planType(args: Record<string, unknown>): AppControlPlan {
  const text = args.text;
  if (!onlyKeys(args, ['text']) || typeof text !== 'string' || text.length < 1 || text.length > 2000 || text.startsWith('-')) {
    return { ok: false, content: APP_CONTROL_PLAIN };
  }
  return { ok: true, script: TYPE_SCRIPT, extraArgs: [text] };
}

function planKey(args: Record<string, unknown>): AppControlPlan {
  if (!onlyKeys(args, ['key']) || typeof args.key !== 'string') {
    return { ok: false, content: APP_CONTROL_KEY };
  }
  const script = KEY_SCRIPTS[args.key as AppControlKey];
  if (!script) return { ok: false, content: APP_CONTROL_KEY };
  return { ok: true, script, extraArgs: [] };
}

export function planAppControlCall(toolName: string, args: unknown): AppControlPlan {
  if (!isAppControlToolName(toolName)) return { ok: false, content: APP_CONTROL_PLAIN };
  if (!isRecord(args)) return { ok: false, content: APP_CONTROL_PLAIN };
  if (containsInjection(args)) return { ok: false, content: APP_CONTROL_REJECTED };
  switch (toolName) {
    case 'app_activate':
      return planActivate(args);
    case 'app_type_text':
      return planType(args);
    case 'app_keystroke':
      return planKey(args);
    default: {
      const unreachable: never = toolName;
      return unreachable;
    }
  }
}
