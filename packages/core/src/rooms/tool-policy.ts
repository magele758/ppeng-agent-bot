/**
 * Room work cannot schedule other members, spawn work, or escape the Room's turn budget.
 * `message_agent` is the one private-delivery exception: a member may send one roster bot a 1:1
 * note. The tool itself refuses non-bots, hop storms, and anything that would write the reply back.
 */
const DENIED = new Set([
  'send_message', 'read_inbox', 'list_team',
  'spawn_subagent', 'spawn_teammate', 'schedule_social_post',
  'task_create', 'task_get', 'task_update', 'task_list',
  'claude_code', 'codex_exec', 'cursor_agent', 'bg_run'
]);
export function filterRoomTools<T extends { name: string }>(
  session: { metadata?: Record<string, unknown> }, tools: readonly T[]
): T[] {
  if (typeof session.metadata?.roomId !== 'string') return tools as T[];
  return tools.filter(tool => !DENIED.has(tool.name) && !/^(bot_|lab_|cron_|routine_|team_|swarm_|orchestration_|spawn_)/.test(tool.name));
}
