'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import type { LivingFaceMood } from '@/lib/bot-face';
import { BotFace } from './BotFace';
import { useBotWorkStates } from './bot-work/BotWorkState';

export type ComposerBotChoice = { id: string; name: string };

export type ComposerBotPickerProps = {
  bots: readonly ComposerBotChoice[];
  value: string;
  selectedName?: string;
  /** A selected id that is not in `bots` yet, so the control can still show it. */
  orphan?: ComposerBotChoice | null;
  mood?: LivingFaceMood;
  onSelect: (id: string) => void;
};

export function ComposerBotPicker({
  bots,
  value,
  selectedName = '',
  orphan = null,
  mood = 'idle',
  onSelect
}: ComposerBotPickerProps) {
  const { t } = useI18n();
  const workStates = useBotWorkStates();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options = useMemo(() => {
    const rows: ComposerBotChoice[] = [{ id: '', name: t('play.selectBot') }];
    if (orphan && !bots.some((bot) => bot.id === orphan.id)) rows.push(orphan);
    rows.push(...bots);
    return rows;
  }, [bots, orphan, t]);

  const displayName = value ? selectedName || value : t('play.selectBot');
  const faceName = value ? selectedName || value : '';

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    setActive((index) => Math.min(index, Math.max(0, options.length - 1)));
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`bot-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function choose(id: string) {
    setOpen(false);
    if (id !== value) onSelect(id);
  }

  function openMenu() {
    const selected = options.findIndex((option) => option.id === value);
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActive((index) => Math.min(options.length - 1, index + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActive((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActive(options.length - 1);
      return;
    }
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const option = options[active];
      if (option) choose(option.id);
    }
  }

  return (
    <div className="composer-bot-picker" ref={rootRef}>
      <button
        type="button"
        className={`composer-bot-picker__trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="botSelectMenu"
        aria-activedescendant={open ? `bot-opt-${active}` : undefined}
        aria-label={value ? t('play.botPickerCurrent', { name: displayName }) : t('play.selectBot')}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <BotFace name={faceName} mood={mood} testId="bot-picker-face" />
        <span className="composer-bot-picker__name">{displayName}</span>
        <span className="composer-bot-picker__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      <label className="sr-only" htmlFor="botSelect">
        {t('play.bot')}
      </label>
      <select
        id="botSelect"
        className="composer-bot-select"
        aria-hidden="true"
        tabIndex={-1}
        value={value}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">{t('play.selectBot')}</option>
        {orphan && !bots.some((bot) => bot.id === orphan.id) ? (
          <option value={orphan.id}>{orphan.name}</option>
        ) : null}
        {bots.map((bot) => (
          <option key={bot.id} value={bot.id}>
            {bot.name}
          </option>
        ))}
      </select>
      {open ? (
        <ul id="botSelectMenu" className="composer-bot-menu" role="listbox" aria-label={t('play.botPickerList')}>
          {options.map((option, index) => {
            const selected = option.id === value;
            return (
              <li key={option.id || 'none'}>
                <button
                  type="button"
                  role="option"
                  id={`bot-opt-${index}`}
                  aria-selected={selected}
                  className={`composer-bot-option${index === active ? ' is-active' : ''}${selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option.id)}
                >
                  <BotFace name={option.id ? option.name : ''} mood={workStates[option.id] > 0 ? 'thinking' : 'idle'} />
                  <span>{option.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
