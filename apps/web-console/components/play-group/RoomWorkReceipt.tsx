'use client';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { useLab } from '../shell/LabProvider';
export type RoomWorkReceiptData = {
    kind: 'accepted' | 'state' | 'clarify';
    goalId?: string;
    sessionId?: string;
    botId?: string;
    status?: string;
    draining?: boolean;
};
export function RoomWorkReceipt({ receipt, onOpen }: {
    receipt: RoomWorkReceiptData;
    onOpen?: (id: string) => void;
}) {
    const { t } = useI18n(), { openSession } = useLab();
    const states = new Set(['queued', 'running', 'paused', 'waiting', 'blocked', 'pending_review', 'completed', 'failed', 'cancelled']);
    return <section data-testid="room-work-receipt">
  <strong>{t(`play.roomWork.${receipt.kind}`)}</strong>
  {receipt.status && <p>{t('play.roomWork.status', { status: t((states.has(receipt.status) ? `play.roomWork.states.${receipt.status}` : 'play.roomWork.states.unknown') as MessageKey) })}</p>}
  <p>{t('play.roomWork.discussion')}</p>
  {receipt.draining && <p>{t('play.roomWork.draining')}</p>}
  {receipt.sessionId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen ? onOpen(receipt.sessionId!) : void openSession(receipt.sessionId!, { focusChat: true })}>{t('play.roomWork.open')}</button>}
 </section>;
}
