import { describe, expect, it, vi } from 'vitest';

import { RuntimeManager } from '../src/runtime/RuntimeManager.js';
import { TOOL_ADD_CODE_CELL, TOOL_RUN_CODE_CELL } from '../src/constants.js';

function createDeps(isConnected = true) {
  const callTool = vi.fn();
  const proxy = {
    callTool,
    get isConnected() {
      return isConnected;
    },
  };
  const browser = {
    selectRuntime: vi.fn().mockResolvedValue(undefined),
    stopRuntime: vi.fn().mockResolvedValue(undefined),
    ensureRuntimeConnected: vi.fn().mockResolvedValue(undefined),
  };
  return { proxy, browser, callTool };
}

describe('RuntimeManager', () => {
  it('selects runtime and waits for reconnect', async () => {
    const { proxy, browser } = createDeps(true);
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    await manager.select('t4');
    expect(browser.selectRuntime).toHaveBeenCalledWith('t4');
  });

  it('disconnects runtime via browser', async () => {
    const { proxy, browser } = createDeps();
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    await manager.disconnect();
    expect(browser.stopRuntime).toHaveBeenCalled();
  });

  it('health returns alive CPU runtime', async () => {
    const { proxy, browser, callTool } = createDeps();
    callTool
      .mockResolvedValueOnce({ structuredContent: { newCellId: 'h1' } })
      .mockResolvedValueOnce({
        structuredContent: {
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['{"has_gpu":false,"gpu_name":""}\n'] }],
          isError: false,
        },
      });
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    const health = await manager.health();
    expect(health.alive).toBe(true);
    expect(health.hasGpu).toBe(false);
    expect(health.runtimeType).toBe('CPU');
    expect(callTool).toHaveBeenCalledWith(TOOL_ADD_CODE_CELL, expect.any(Object));
    expect(callTool).toHaveBeenCalledWith(TOOL_RUN_CODE_CELL, { cellId: 'h1' });
  });

  it('health returns GPU info when present', async () => {
    const { proxy, browser, callTool } = createDeps();
    callTool
      .mockResolvedValueOnce({ structuredContent: { newCellId: 'h2' } })
      .mockResolvedValueOnce({
        structuredContent: {
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: ['{"has_gpu":true,"gpu_name":"Tesla T4"}\n'],
            },
          ],
          isError: false,
        },
      });
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    const health = await manager.health();
    expect(health.hasGpu).toBe(true);
    expect(health.gpuName).toBe('Tesla T4');
    expect(health.runtimeType).toBe('Tesla T4');
  });

  it('wraps health failures', async () => {
    const { proxy, browser, callTool } = createDeps();
    callTool.mockRejectedValue(new Error('health rpc failed'));
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    await expect(manager.health()).rejects.toThrow('health rpc failed');
  });

  it('wraps select failures', async () => {
    const { proxy, browser } = createDeps();
    browser.selectRuntime.mockRejectedValue(new Error('ui missing'));
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    await expect(manager.select('a100')).rejects.toThrow('ui missing');
  });

  it('health returns dead when cell id missing', async () => {
    const { proxy, browser, callTool } = createDeps();
    callTool.mockResolvedValueOnce({ structuredContent: {} });
    const manager = new RuntimeManager(() => proxy as never, browser as never);
    const health = await manager.health();
    expect(health.alive).toBe(false);
    expect(health.runtimeType).toBe('unknown');
  });
});
