'use client';

import type { ReactNode } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { SectionId } from '@/lib/nav';
import { Section, SubTabs, type SubTabItem } from '../ui';
import { useSectionNav } from '../shell/useSectionNav';

export interface SectionFrameProps {
  section: Exclude<SectionId, 'chat' | 'settings' | 'bot'>;
  active: boolean;
  /** 可选：覆盖某个子页的徽标 */
  badges?: Partial<Record<string, number>>;
  actions?: ReactNode;
  /** 返回当前子页内容；仅当前激活 section 才会调用 */
  renderSub: (sub: string) => ReactNode;
}

/** 带子页签的 section 外框。对话与 Bot 走 Play 面板，设置自有布局。 */
export function SectionFrame({ section, active, badges, actions, renderSub }: SectionFrameProps) {
  const { t } = useI18n();
  const { sub, select, subs } = useSectionNav(section);
  if (!active) return null;
  const items: SubTabItem[] = subs.map((id) => ({
    id,
    label: t(`shell.sub.${section}.${id}` as MessageKey),
    badge: badges?.[id]
  }));
  return (
    <div className="lab-page">
      <Section
        id={`section-${section}`}
        title={t(`shell.nav.${section}`)}
        description={t(`shell.desc.${section}`)}
        actions={actions}
        nav={<SubTabs items={items} active={sub} onSelect={select} ariaLabel={t('shell.nav.subPages')} idPrefix={`section-${section}`} />}
      >
        {sub ? <div id={`section-${section}-${sub}`}>{renderSub(sub)}</div> : null}
      </Section>
    </div>
  );
}
