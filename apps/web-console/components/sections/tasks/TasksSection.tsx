'use client';

import { api } from '@/lib/api';
import { BotTeamWork } from '../../bot-work/BotTeamWork';
import { useLab } from '../../shell/LabProvider';
import { SectionFrame } from '../SectionFrame';
import { InboxView } from './InboxView';
import { RunsView } from './RunsView';
import { TaskQueueView } from './TaskQueueView';

export function TasksSection({ active }: { active: boolean }) {
  const lab = useLab();
  return (
    <SectionFrame
      section="tasks"
      active={active}
      badges={{ inbox: lab.approvals.length }}
      renderSub={(sub) => {
        switch (sub) {
          case 'queue':
            return <TaskQueueView />;
          case 'bots':
            return <BotTeamWork bots={lab.bots} onOpen={async (bot) => {
              const data = await api(`/api/bots/${encodeURIComponent(bot.id)}/open`, { method: 'POST' }) as { session: { id: string } };
              await lab.openSession(data.session.id, { focusChat: true });
            }} />;
          case 'runs':
            return <RunsView />;
          case 'inbox':
            return <InboxView />;
          default:
            return null;
        }
      }}
    />
  );
}
