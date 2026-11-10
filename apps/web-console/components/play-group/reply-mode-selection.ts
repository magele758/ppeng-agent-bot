import { api } from '@/lib/api';
import { saveGroupReplyMode, type GroupReplyMode } from '@/lib/group-reply-mode';

const pending = new Map<string, ReplyModeSelection>();

export function roomReplySelection(roomId: string, initial: GroupReplyMode) {
  return pending.get(roomId) ?? new ReplyModeSelection(roomId, initial);
}

class ReplyModeSelection {
  private confirmed: GroupReplyMode;
  private state: { mode: GroupReplyMode; error: string };
  private listeners = new Set<() => void>();

  constructor(private roomId: string, initial: GroupReplyMode) {
    this.confirmed = initial;
    this.state = { mode: initial, error: '' };
  }

  snapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(mode: GroupReplyMode, error = '') {
    this.state = { mode, error };
    for (const listener of this.listeners) listener();
  }

  async choose(mode: GroupReplyMode) {
    this.publish(mode);
    if (pending.has(this.roomId)) return;
    pending.set(this.roomId, this);
    try {
      while (this.confirmed !== this.state.mode) {
        const requested = this.state.mode;
        const result = await saveGroupReplyMode(api, this.roomId, this.confirmed, requested);
        this.confirmed = result.mode;
        if (!result.saved && this.state.mode === requested) this.publish(this.confirmed, result.error);
      }
    } finally {
      pending.delete(this.roomId);
    }
  }
}
