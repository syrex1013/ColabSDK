import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeepAlive } from '../src/keepalive/KeepAlive.js';

function createMockPage() {
  const evaluate = vi.fn().mockResolvedValue(undefined);
  return { evaluate, isClosed: () => false };
}

describe('KeepAlive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects keepalive script on start', async () => {
    const page = createMockPage();
    const keepAlive = new KeepAlive(1000);
    await keepAlive.start(page as never);

    expect(page.evaluate).toHaveBeenCalled();
    const script = page.evaluate.mock.calls[0]?.[0] as string;
    expect(script).toContain('__colabsdk_keepalive');
    keepAlive.stop();
  });

  it('re-injects on interval and clears on stop', async () => {
    vi.useFakeTimers();
    const page = createMockPage();
    const keepAlive = new KeepAlive(500);
    await keepAlive.start(page as never);

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTime(500);
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(2);

    keepAlive.stop();
    const stopCall = page.evaluate.mock.calls.find((call) =>
      String(call[0]).includes('clearInterval'),
    );
    expect(stopCall).toBeDefined();
  });
});
