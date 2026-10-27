'use client';

import { useI18n } from '@/lib/i18n';
import { isPlaySection } from '@/lib/nav';
import type { AuthUser } from '@/lib/auth';
import { AccountMenu } from '../AccountMenu';
import { LanguageToggle } from '../LanguageToggle';
import { ModelSettingsDialog } from '../ModelSettingsDialog';
import { SkinToggle } from '../SkinToggle';
import { ThemeToggle } from '../ThemeToggle';
import { AgentsSection } from '../sections/agents/AgentsSection';
import { ChatSection } from '../sections/chat/ChatSection';
import { KnowledgeSection } from '../sections/knowledge/KnowledgeSection';
import { SettingsSection } from '../sections/settings/SettingsSection';
import { TasksSection } from '../sections/tasks/TasksSection';
import { useLab } from './LabProvider';
import { Rail } from './Rail';
import { ShellToolbar } from './ShellToolbar';

export function LabShell({ authUser }: { authUser: AuthUser | null }) {
  const { t } = useI18n();
  const { location, modelSetupOpen, setModelSetupOpen, getChatBridge } = useLab();
  const section = location.section;
  const onPlay = isPlaySection(section);

  return (
    <>
      <a className="skip-link" href="#lab-main">
        {t('nav.skipToContent')}
      </a>
      <div className="ambient" aria-hidden="true">
        <div className="ambient-grid" />
      </div>
      <div className="app lab-shell">
        <Rail
          footer={(collapsed) => (
            <>
              <button
                type="button"
                className={`btn btn-ghost btn-sm lab-rail__tool${modelSetupOpen ? ' is-active' : ''}`}
                id="btnModelSetup"
                aria-haspopup="dialog"
                aria-expanded={modelSetupOpen}
                title={t('nav.configureModel')}
                onClick={() => setModelSetupOpen(true)}
              >
                <span className="lab-rail__icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                  </svg>
                </span>
                <span className="lab-rail__label">{t('nav.configureModel')}</span>
              </button>
              <LanguageToggle compact={collapsed} />
              <SkinToggle />
              <ThemeToggle />
              {authUser ? <AccountMenu user={authUser} compact={collapsed} /> : null}
            </>
          )}
        />
        <main className="lab-main" id="lab-main">
          {onPlay ? null : <ShellToolbar />}
          <div className="lab-view" hidden={!onPlay}>
            <ChatSection active={onPlay} />
          </div>
          <AgentsSection active={section === 'agents'} />
          <TasksSection active={section === 'tasks'} />
          <KnowledgeSection active={section === 'knowledge'} />
          <SettingsSection active={section === 'settings'} />
        </main>
        <ModelSettingsDialog
          open={modelSetupOpen}
          onClose={() => setModelSetupOpen(false)}
          onCatalogChange={(data) => getChatBridge()?.applyModelCatalog(data)}
        />
      </div>
    </>
  );
}
