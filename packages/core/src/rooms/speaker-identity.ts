/** Shown when a bot is about to reply inside a group turn. */
export const GROUP_TURN_SPEAKS_AS_SELF =
  'Your reply is posted in this Room under your own name automatically. You do not choose a sender and cannot speak as someone else. Do not say you are unable to speak as yourself.';

/** Standing rule for private chats, before a bot tries to post into a group. */
export const PRIVATE_CHAT_GROUP_SPEAKER_RULE =
  'When you reply during a group turn, that reply is posted under your own name automatically. You do not choose a sender. bot_room_post posts as the person and wakes the group; do not use it for words that should appear as you. Do not say you are unable to speak as yourself.';
