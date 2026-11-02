'use client';

import { shownGroupMembers } from '../../lib/group-members';
import { BotFace } from '../BotFace';

export type GroupMemberFace = { id: string; name: string };

/** Up to four bot faces, arranged like a group-chat avatar. */
export function GroupFace({ members }: { members: readonly GroupMemberFace[] }) {
  const shown = shownGroupMembers(members);
  if (!shown.length) return null;
  return (
    <span className={`group-face group-face--${shown.length}`} data-testid="group-face" data-count={shown.length} aria-hidden="true">
      {shown.map((member) => (
        <span key={member.id} className="group-face__cell" title={member.name}>
          <BotFace name={member.name} botId={member.id} size="sm" />
        </span>
      ))}
    </span>
  );
}
