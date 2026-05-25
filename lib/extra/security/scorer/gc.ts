import { ofetch } from 'ofetch';

export class L1ModelGC {
  private lastActive = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly gcMinutes: number,
  ) {}

  touch(): void {
    this.lastActive = Date.now();
  }

  start(): void {
    if (this.gcMinutes <= 0) return;
    if (this.timer) return;

    const intervalMs = this.gcMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      const idleMs = Date.now() - this.lastActive;
      if (idleMs >= intervalMs) {
        this.unload().catch(() => {});
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async unload(): Promise<void> {
    try {
      await ofetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: this.model,
          keep_alive: 0,
        },
        timeout: 10000,
      });
    } catch {
      // Ollama may not support keep_alive; ignore errors
    }
  }
}
