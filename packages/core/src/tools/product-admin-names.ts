/** Product-admin tools a delegated child must not inherit. Room turns drop every `bot_*` / `lab_*` name and these aliases. */
const EXACT = new Set([
  'bot_list',
  'bot_get',
  'bot_create',
  'create_bot',
  'bot_update',
  'bot_open',
  'bot_work_control_set',
  'create_room'
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
