/** Keeps the screen on. iPhones need this, since a locked phone stops web audio; the Android app does not. */
export class ScreenWake {
  private lock: WakeLockSentinel | undefined;
  private wanted = false;

  private readonly onVisible = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire();
  };

  async enable(): Promise<void> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    await this.acquire();
  }

  disable(): void {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    void this.lock?.release();
    this.lock = undefined;
  }

  private async acquire(): Promise<void> {
    try {
      this.lock = await navigator.wakeLock?.request('screen');
    } catch {
      // Refused, for example on low battery. Nothing useful to do about it.
    }
  }
}
