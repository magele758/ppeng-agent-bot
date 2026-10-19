/** Product-admin tools a delegated child must not inherit. Room turns already drop every `bot_*` / `lab_*` name. */
const EXACT = new Set([
  'bot_list',
  'bot_get',
  'bot_create',
  'bot_update',
  'bot_open',
  'bot_work_control_set'
]);

export function isDelegatedProductAdminTool(name: string): boolean {
  return (
    EXACT.has(name) ||
    name.startsWith('bot_room_') ||
    name.startsWith('bot_group_') ||
    name.startsWith('bot_shared_') ||
    name.startsWith('lab_')
  );
}
