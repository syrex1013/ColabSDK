import type { Page } from 'playwright-core';

import { KEEPALIVE_SCRIPT } from '../constants.js';

export class KeepAlive {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private page: Page | null = null;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  async start(page: Page): Promise<void> {
    this.page = page;
    const script = KEEPALIVE_SCRIPT.replace('__INTERVAL__', String(this.intervalMs));
    await page.evaluate(script);

    this.timer = setInterval(() => {
      void page.evaluate(script).catch(() => {
        // page may be closed
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.page) {
      void this.page
        .evaluate(`(() => {
          const id = window.__colabsdk_keepalive;
          if (id) clearInterval(id);
          delete window.__colabsdk_keepalive;
        })()`)
        .catch(() => {});
      this.page = null;
    }
  }
}
