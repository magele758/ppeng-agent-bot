'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import '../sections/settings/categories/kit/settings-kit.css';

export function ExperimentRow({
  id,
  switchId,
  title,
  description,
  on,
  busy = false,
  onChange,
  children
}: {
  id?: string;
  switchId: string;
  title: string;
  description: string;
  on: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="ui-group" id={id} aria-label={title}>
      <header className="ui-group__head">
        <div className="ui-group__heading">
          <h2 className="ui-group__title">{title}</h2>
          <p className="ui-group__desc">{description}</p>
        </div>
        <label className="settings-switch">
          <input
            type="checkbox"
            role="switch"
            checked={on}
            disabled={busy}
            aria-label={t('settings.experimentalSwitch', { name: title })}
            data-testid={`experiment-switch-${switchId}`}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span aria-hidden="true">{on ? t('settingsEntries.common.on') : t('settingsEntries.common.off')}</span>
        </label>
      </header>
      {on && children ? <div className="ui-group__body">{children}</div> : null}
    </section>
  );
}
