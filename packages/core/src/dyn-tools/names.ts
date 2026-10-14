import { isPtcReservedIdentifier, PTC_NAMESPACE_BLOCKED_NAMES } from '../ptc/hooks.js';
import { DYN_META_TOOL_NAMES } from './types.js';

const EXTRA_RESERVED = new Set<string>([
  ...DYN_META_TOOL_NAMES,
  'ptc_exec',
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'glob_files',
  'web_fetch',
  'web_search',
  'load_skill',
  'search_skills',
  'tool_search',
  'load_capability_tool',
  'args',
  'grep_files',
  'browser_screenshot',
  'history_search',
  'history_read',
  'memory_read',
  'message_agent'
]);

export function collectReservedDynToolNames(processTools?: Array<{ name: string }>): Set<string> {
  const names = new Set<string>(EXTRA_RESERVED);
  for (const blocked of PTC_NAMESPACE_BLOCKED_NAMES) names.add(blocked);
  for (const tool of processTools ?? []) {
    const n = String(tool.name ?? '').trim();
    if (n) names.add(n);
  }
  return names;
}

export function isReservedDynToolName(name: string, reserved: Iterable<string>): boolean {
  if (name.startsWith('cron_')) return true;
  if (isPtcReservedIdentifier(name)) return true;
  if (PTC_NAMESPACE_BLOCKED_NAMES.has(name)) return true;
  for (const item of reserved) {
    if (item === name) return true;
  }
  return EXTRA_RESERVED.has(name);
}
