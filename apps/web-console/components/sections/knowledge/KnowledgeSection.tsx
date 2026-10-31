'use client';

import { IngestionSettingsCard } from '../../IngestionSettingsCard';
import { MemoryPanel } from '../../MemoryPanel';
import { AdvancedToggle } from '../../ui';
import { SectionFrame } from '../SectionFrame';
import { LibraryDirsCard } from './LibraryDirsCard';
import { LibraryPagesPanel } from './LibraryPagesPanel';

export function KnowledgeSection({ active }: { active: boolean }) {
  return (
    <SectionFrame
      section="knowledge"
      active={active}
      actions={<AdvancedToggle />}
      renderSub={(sub) => {
        switch (sub) {
          case 'memory':
            return (
              <>
                <LibraryDirsCard />
                <MemoryPanel />
              </>
            );
          case 'pages':
            return <LibraryPagesPanel />;
          case 'ingestion':
            return <IngestionSettingsCard />;
          default:
            return null;
        }
      }}
    />
  );
}
