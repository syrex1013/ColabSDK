import { describe, expect, it, vi } from 'vitest';

import { CellManager } from '../src/cells/CellManager.js';
import { CellNotFoundError } from '../src/errors/index.js';
import {
  TOOL_ADD_CODE_CELL,
  TOOL_ADD_TEXT_CELL,
  TOOL_DELETE_CELL,
  TOOL_GET_CELLS,
  TOOL_MOVE_CELL,
  TOOL_UPDATE_CELL,
} from '../src/constants.js';

function createMockProxy() {
  const callTool = vi.fn();
  return {
    callTool,
    isConnected: true,
  };
}

describe('CellManager', () => {
  it('lists cells from structured content', async () => {
    const proxy = createMockProxy();
    proxy.callTool.mockResolvedValue({
      structuredContent: {
        cells: [{ cellId: 'a', cellType: 'code', source: '1+1', cellIndex: 0 }],
      },
    });
    const manager = new CellManager(() => proxy as never);
    const cells = await manager.list();
    expect(cells).toHaveLength(1);
    expect(cells[0]?.cellId).toBe('a');
    expect(proxy.callTool).toHaveBeenCalledWith(TOOL_GET_CELLS, {});
  });

  it('creates code cell and resolves from list', async () => {
    const proxy = createMockProxy();
    proxy.callTool
      .mockResolvedValueOnce({ structuredContent: { newCellId: 'new1' } })
      .mockResolvedValueOnce({
        structuredContent: {
          cells: [{ cellId: 'new1', cellType: 'code', source: 'print(1)', cellIndex: 0 }],
        },
      });
    const manager = new CellManager(() => proxy as never);
    const cell = await manager.createCode('print(1)');
    expect(cell.cellId).toBe('new1');
    expect(proxy.callTool).toHaveBeenCalledWith(TOOL_ADD_CODE_CELL, {
      cellIndex: 0,
      language: 'python',
      code: 'print(1)',
    });
  });

  it('creates markdown cell', async () => {
    const proxy = createMockProxy();
    proxy.callTool
      .mockResolvedValueOnce({ structuredContent: { newCellId: 'md1' } })
      .mockResolvedValueOnce({
        structuredContent: {
          cells: [{ cellId: 'md1', cellType: 'text', source: '# Hi', cellIndex: 0 }],
        },
      });
    const manager = new CellManager(() => proxy as never);
    const cell = await manager.createMarkdown('# Hi');
    expect(cell.cellType).toBe('text');
    expect(proxy.callTool).toHaveBeenCalledWith(TOOL_ADD_TEXT_CELL, {
      cellIndex: 0,
      content: '# Hi',
    });
  });

  it('edits cell and returns updated source', async () => {
    const proxy = createMockProxy();
    proxy.callTool
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        structuredContent: {
          cells: [{ cellId: 'c1', cellType: 'code', source: 'old', cellIndex: 0 }],
        },
      });
    const manager = new CellManager(() => proxy as never);
    const cell = await manager.edit('c1', 'new code');
    expect(cell.source).toBe('new code');
    expect(proxy.callTool).toHaveBeenCalledWith(TOOL_UPDATE_CELL, { cellId: 'c1', content: 'new code' });
  });

  it('throws when edit target disappears', async () => {
    const proxy = createMockProxy();
    proxy.callTool.mockResolvedValueOnce({}).mockResolvedValueOnce({ structuredContent: { cells: [] } });
    const manager = new CellManager(() => proxy as never);
    await expect(manager.edit('missing', 'x')).rejects.toThrow(CellNotFoundError);
  });

  it('removes and moves cells', async () => {
    const proxy = createMockProxy();
    proxy.callTool.mockResolvedValue({});
    const manager = new CellManager(() => proxy as never);
    await manager.remove('c1');
    await manager.move('c1', 2);
    expect(proxy.callTool).toHaveBeenCalledWith(TOOL_DELETE_CELL, { cellId: 'c1' });
    expect(proxy.callTool).toHaveBeenCalledWith(TOOL_MOVE_CELL, { cellId: 'c1', cellIndex: 2 });
  });

  it('resolves by index and id', async () => {
    const proxy = createMockProxy();
    proxy.callTool.mockResolvedValue({
      structuredContent: {
        cells: [
          { cellId: 'a', cellType: 'code', source: '', cellIndex: 0 },
          { cellId: 'b', cellType: 'code', source: '', cellIndex: 1 },
        ],
      },
    });
    const manager = new CellManager(() => proxy as never);
    expect((await manager.resolve(1)).cellId).toBe('b');
    expect((await manager.resolve('a')).cellId).toBe('a');
    await expect(manager.resolve(99)).rejects.toThrow(CellNotFoundError);
    await expect(manager.resolve('zzz')).rejects.toThrow(CellNotFoundError);
  });

  it('sourceOf joins cell source', () => {
    const proxy = createMockProxy();
    const manager = new CellManager(() => proxy as never);
    expect(manager.sourceOf({ cellId: 'x', cellIndex: 0, cellType: 'code', source: 'a\nb' })).toBe('a\nb');
  });

  it('wraps list failures', async () => {
    const proxy = createMockProxy();
    proxy.callTool.mockRejectedValue(new Error('rpc down'));
    const manager = new CellManager(() => proxy as never);
    await expect(manager.list()).rejects.toThrow('rpc down');
  });

  it('falls back when createCode list misses new cell', async () => {
    const proxy = createMockProxy();
    proxy.callTool
      .mockResolvedValueOnce({ structuredContent: { newCellId: 'fallback' } })
      .mockResolvedValueOnce({ structuredContent: { cells: [] } });
    const manager = new CellManager(() => proxy as never);
    const cell = await manager.createCode('x=1', { index: 3 });
    expect(cell.cellId).toBe('fallback');
    expect(cell.cellIndex).toBe(3);
  });
});
