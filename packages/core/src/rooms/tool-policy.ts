/** Room work cannot schedule private Bot work or escape the Room's turn budget. */
const DENIED = new Set([
  'message_agent', 'send_message', 'read_inbox', 'list_team',
  'spawn_subagent', 'spawn_teammate', 'schedule_social_post',
  'task_create', 'task_get', 'task_update', 'task_list',
  'claude_code', 'codex_exec', 'cursor_agent', 'bg_run'
]);
export function filterRoomTools<T extends { name: string }>(
  session: { metadata?: Record<string, unknown> }, tools: readonly T[]
): T[] {
  if (typeof session.metadata?.roomId !== 'string') return tools as T[];
  return tools.filter(tool => !DENIED.has(tool.name) && !/^(bot_|cron_|routine_|team_|swarm_|orchestration_|spawn_)/.test(tool.name));
}
