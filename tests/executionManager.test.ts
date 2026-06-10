import { describe, expect, it, vi } from 'vitest';

import { CellManager } from '../src/cells/CellManager.js';
import { ExecutionManager } from '../src/execution/ExecutionManager.js';
import { ExecutionError } from '../src/errors/index.js';
import { TOOL_RUN_CODE_CELL } from '../src/constants.js';

function createDeps() {
  const callTool = vi.fn();
  const proxy = { callTool, isConnected: true };
  const cells = {
    resolve: vi.fn(),
    list: vi.fn(),
    createCode: vi.fn(),
    remove: vi.fn(),
  };
  const browser = {
    ensureRuntimeConnected: vi.fn().mockResolvedValue(undefined),
    interruptExecution: vi.fn().mockResolvedValue(undefined),
  };
  return { proxy, cells, browser, callTool };
}

describe('ExecutionManager', () => {
  it('runs cell and returns stdout', async () => {
    const { proxy, cells, browser, callTool } = createDeps();
    cells.resolve.mockResolvedValue({ cellId: 'c1', cellIndex: 0, cellType: 'code', source: 'print(1)' });
    callTool.mockResolvedValue({
      structuredContent: {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['ok\n'] }],
        isError: false,
      },
    });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    const result = await manager.runCell('c1');
    expect(result.stdout).toBe('ok\n');
    expect(result.cellId).toBe('c1');
    expect(browser.ensureRuntimeConnected).toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith(TOOL_RUN_CODE_CELL, { cellId: 'c1' }, 180_000);
  });

  it('throws ExecutionError on cell error output', async () => {
    const { proxy, cells, browser, callTool } = createDeps();
    cells.resolve.mockResolvedValue({ cellId: 'c1', cellIndex: 0, cellType: 'code', source: 'raise' });
    callTool.mockResolvedValue({
      structuredContent: {
        outputs: [{ output_type: 'error', traceback: ['Traceback'] }],
        isError: true,
      },
    });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    await expect(manager.runCell('c1')).rejects.toThrow(ExecutionError);
  });

  it('runCode creates, runs, and cleans up', async () => {
    const { proxy, cells, browser, callTool } = createDeps();
    cells.createCode.mockResolvedValue({ cellId: 'temp', cellIndex: 0, cellType: 'code', source: '1' });
    cells.resolve.mockResolvedValue({ cellId: 'temp', cellIndex: 0, cellType: 'code', source: '1' });
    cells.remove.mockResolvedValue(undefined);
    callTool.mockResolvedValue({
      structuredContent: { outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }], isError: false },
    });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    const result = await manager.runCode('1', { cleanup: true });
    expect(result.stdout).toBe('1\n');
    expect(cells.remove).toHaveBeenCalledWith('temp');
  });

  it('runAll skips empty and markdown cells', async () => {
    const { proxy, cells, browser, callTool } = createDeps();
    cells.list.mockResolvedValue([
      { cellId: 'm', cellIndex: 0, cellType: 'text', source: '# x' },
      { cellId: 'e', cellIndex: 1, cellType: 'code', source: '   ' },
      { cellId: 'c', cellIndex: 2, cellType: 'code', source: 'print(2)' },
    ]);
    cells.resolve.mockResolvedValue({ cellId: 'c', cellIndex: 2, cellType: 'code', source: 'print(2)' });
    callTool.mockResolvedValue({
      structuredContent: { outputs: [{ output_type: 'stream', name: 'stdout', text: ['2\n'] }], isError: false },
    });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    const results = await manager.runAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toBe('2\n');
  });

  it('interrupt sets flag and calls browser', async () => {
    const { proxy, cells, browser } = createDeps();
    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    await manager.interrupt();
    expect(browser.interruptExecution).toHaveBeenCalled();
  });

  it('interrupt wraps browser errors', async () => {
    const { proxy, cells, browser } = createDeps();
    browser.interruptExecution.mockRejectedValue(new Error('no runtime'));
    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    await expect(manager.interrupt()).rejects.toThrow('no runtime');
  });

  it('streamCell yields final result', async () => {
    const { proxy, cells, browser, callTool } = createDeps();
    const cell = { cellId: 's1', cellIndex: 0, cellType: 'code' as const, source: 'print(3)', outputs: [] };
    cells.resolve.mockResolvedValue(cell);
    cells.list.mockResolvedValue([cell]);
    callTool.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {
        structuredContent: {
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['3\n'] }],
          isError: false,
        },
      };
    });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    const chunks = [];
    for await (const chunk of manager.streamCell('s1')) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.type === 'result')).toBe(true);
    expect(chunks.at(-1)?.text).toContain('3');
  });

  it('streamCell throws on execution error', async () => {
    const { proxy, cells, browser, callTool } = createDeps();
    const cell = { cellId: 'e1', cellIndex: 0, cellType: 'code' as const, source: 'raise', outputs: [] };
    cells.resolve.mockResolvedValue(cell);
    cells.list.mockResolvedValue([cell]);
    callTool.mockResolvedValue({
      structuredContent: {
        outputs: [{ output_type: 'error', traceback: ['boom'] }],
        isError: true,
      },
    });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    const chunks = [];
    await expect(async () => {
      for await (const chunk of manager.streamCell('e1')) {
        chunks.push(chunk);
      }
    }).rejects.toThrow(ExecutionError);
  });

  it('retries runCell up to 3 times', async () => {
    vi.useFakeTimers();
    const { proxy, cells, browser, callTool } = createDeps();
    cells.resolve.mockResolvedValue({ cellId: 'c1', cellIndex: 0, cellType: 'code', source: 'x' });
    callTool
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({
        structuredContent: { outputs: [{ output_type: 'stream', name: 'stdout', text: ['ok'] }], isError: false },
      });

    const manager = new ExecutionManager(() => proxy as never, cells as unknown as CellManager, browser as never);
    const promise = manager.runCell('c1');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.stdout).toBe('ok');
    expect(callTool).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
