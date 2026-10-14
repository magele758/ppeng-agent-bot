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
  'message_agent',
  'vision_analyze',
  'retrieve_tool_result',
  'work_evidence',
  'task_get',
  'task_list',
  'list_team',
  'bg_check',
  'workspace_list',
  'lsp_request',
  'notebook_edit',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'memory_get',
  'memory_prefetch',
  'memory_search',
  'tailscale_list_devices',
  'tailscale_get_device',
  'tailscale_ping',
  'ask_user',
  'save_user_info',
  'collect_credentials',
  'claude_code',
  'codex_exec',
  'cursor_agent',
  'read_artifact_page',
  'search_artifact_content',
  'submit_plan',
  'request_confirmation',
  'confirm_plan',
  'start_step',
  'complete_step',
  'fail_step',
  'bot_team_status',
  'bot_delegate',
  'bot_task_results',
  'skill_propose'
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
