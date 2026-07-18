/**
 * RemoteControlLock manages the read-only state of the CLI TUI when
 * a remote IM user triggers a workflow that executes on this CLI session.
 *
 * When locked:
 * - TUI input is blocked (except R to refresh and /remote commands)
 * - Status bar shows "🔒 Remote Control Active"
 * - Local user cannot interfere with remote workflow execution
 *
 * The lock is acquired when Web pushes a `lock-acquired` event and
 * released when Web pushes a `lock-released` event.
 */
export class RemoteControlLock {
  private locked = false;
  private onChangeCallbacks: Array<(locked: boolean) => void> = [];

  acquire(): void {
    if (this.locked) return;
    this.locked = true;
    this.onChangeCallbacks.forEach((cb) => {
      cb(true);
    });
  }

  release(): void {
    if (!this.locked) return;
    this.locked = false;
    this.onChangeCallbacks.forEach((cb) => {
      cb(false);
    });
  }

  isLocked(): boolean {
    return this.locked;
  }

  onChange(callback: (locked: boolean) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  removeChangeListener(callback: (locked: boolean) => void): void {
    this.onChangeCallbacks = this.onChangeCallbacks.filter(
      (cb) => cb !== callback,
    );
  }
}
