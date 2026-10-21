/** Only the desktop parent can request this barrier over its private IPC channel. */
export class DesktopUpdateGate {
  locked = false;
  mutations = 0;
  schedulerRunning = false;
  constructor(validation: boolean) { this.locked = validation; }
  prepare(active: number, suspend: () => void): boolean {
    if (this.locked || this.mutations || this.schedulerRunning || active) return false;
    this.locked = true;
    suspend();
    return true;
  }
}
