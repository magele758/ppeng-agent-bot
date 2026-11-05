'use client';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import type { BotInfo } from '@/lib/types';
import { BOT_GROUPS_CHANGED_EVENT } from '@/lib/bot-group';
import type { FunctionalGroup } from '@/lib/functional-group-view';
import type { SidebarRoom } from './play-group/PlayBotGroupList';
import './BotRowMenu.css';
import { BotEntryDialog } from './BotEntryDialog';
import { BotDetailMenu } from './BotDetailMenu';

type Destination = { id: string; name: string };
type Picker = 'group' | 'room';

async function destinations(kind: Picker, botId: string): Promise<Destination[]> {
  if (kind === 'group') {
    const { groups } = await api('/api/bot-functional-groups') as { groups: FunctionalGroup[] };
    return groups.filter(group => !group.botIds.includes(botId));
  }
  const { rooms } = await api('/api/bot-rooms') as { rooms: SidebarRoom[] };
  return rooms.filter(room => room.status !== 'paused' && !room.botIds.includes(botId)).map(room => ({id:room.id, name:room.title}));
}

export function BotRowMenu({bot, details, remove, onDeleted}: {bot:BotInfo; details:()=>void; remove:()=>void; onDeleted:()=>void}) {
  const { t } = useI18n();
  const id = useId();
  const pop = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Picker | 'cron' | null>(null);
  const [options, setOptions] = useState<Destination[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function closeMenu() { pop.current?.hidePopover(); }
  async function choose(kind: Picker) {
    closeMenu();
    setView(kind); setBusy(true); setError(''); setOptions([]);
    try { setOptions(await destinations(kind, bot.id)); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function join(target: string) {
    const group = view === 'group';
    setBusy(true); setError('');
    try {
      const path = group ? '/api/bots/' + encodeURIComponent(bot.id) + '/functional-group' : '/api/bot-rooms/' + encodeURIComponent(target) + '/members';
      await api(path, {method: group ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(group ? {groupId:target} : {botId:bot.id})});
      window.dispatchEvent(new Event(group ? 'lab-bot-placement-saved' : BOT_GROUPS_CHANGED_EVENT));
      setView(null);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function destroy() {
    closeMenu();
    if (!window.confirm(t('play.rowMenu.deleteConfirm',{name:bot.name}))) return;
    setBusy(true); setError('');
    try {
      await api('/api/bots/'+encodeURIComponent(bot.id),{method:'DELETE'});
      window.dispatchEvent(new Event('lab-bot-placement-saved'));
      onDeleted();
    } catch(cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  const label = t('play.rowMenu.label',{name:bot.name});
  return <span onKeyDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}>
    <button type="button" className="btn btn-ghost bot-row-trigger" data-testid="bot-row-menu" aria-label={label} popoverTarget={id}
      onClick={e=>{ const rect=e.currentTarget.getBoundingClientRect(); const style=pop.current!.style;
        style.left=Math.max(4,Math.min(rect.right-160,window.innerWidth-168))+'px';
        style.top=Math.max(4,Math.min(rect.bottom+3,window.innerHeight-230))+'px';
      }}>⋯</button>
    <div id={id} ref={pop} popover="auto" className="bot-row-pop" data-testid="bot-row-actions">
      <button onClick={()=>{closeMenu(); details();}}>{t('play.rowMenu.details')}</button>
      <button onClick={()=>{closeMenu(); setView('cron');}}>{t('play.rowMenu.cron')}</button>
      <button onClick={()=>void choose('group')}>{t('play.rowMenu.group')}</button>
      <button onClick={()=>void choose('room')}>{t('play.rowMenu.room')}</button>
      <button onClick={()=>{closeMenu(); remove();}}>{t('play.rowMenu.remove')}</button>
      <button disabled={busy} className="bot-row-danger" onClick={()=>void destroy()}>{t('play.rowMenu.delete')}</button>
    </div>
    <BotMenuError error={error} hidden={Boolean(view)} onClose={()=>setError('')} />
    {view && createPortal(<BotEntryDialog label={label}>
      <div className="bot-row-dialog" data-view={view}>
        <header className="bot-row-dialog__head">
          <div><h3>{t(view === 'cron' ? 'play.rowMenu.cron' : view === 'group' ? 'play.rowMenu.group' : 'play.rowMenu.room')}</h3><p>{bot.name}</p></div>
        </header>
        <div className="bot-row-dialog__body" aria-busy={busy}>
          {view === 'cron' ? <BotDetailMenu botId={bot.id} botName={bot.name}/> :
            <div className="bot-row-picker">
              {busy && <p role="status">{t('play.rowMenu.loading')}</p>}
              {options.map(option => <button type="button" disabled={busy} key={option.id} onClick={() => void join(option.id)}><span>{option.name}</span><span aria-hidden="true">›</span></button>)}
              {!busy && !error && !options.length && <p>{t('play.rowMenu.empty')}</p>}
              {error && <p role="alert">{error}</p>}
            </div>}
        </div>
        <footer className="bot-row-dialog__foot">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setView(null)}>{t('common.cancel')}</button>
        </footer>
      </div>
    </BotEntryDialog>, document.body)}
  </span>;
}

function BotMenuError({error,hidden,onClose}:{error:string;hidden:boolean;onClose:()=>void}) {
  const {t}=useI18n();
  if(hidden || !error) return null;
  return createPortal(<BotEntryDialog label={t('play.rowMenu.delete')}><div className="bot-row-dialog">
    <header className="bot-row-dialog__head"><h3>{t('play.rowMenu.delete')}</h3></header>
    <div className="bot-row-dialog__body"><p role="alert">{error}</p></div>
    <footer className="bot-row-dialog__foot"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button></footer>
  </div></BotEntryDialog>,document.body);
}
