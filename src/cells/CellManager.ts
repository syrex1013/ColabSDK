import {
  TOOL_ADD_CODE_CELL,
  TOOL_ADD_TEXT_CELL,
  TOOL_DELETE_CELL,
  TOOL_GET_CELLS,
  TOOL_MOVE_CELL,
  TOOL_UPDATE_CELL,
} from '../constants.js';
import { CellNotFoundError, wrapError } from '../errors/index.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { Cell } from '../types/index.js';
import { extractCellId, extractCells, joinSource } from './cellUtils.js';

export class CellManager {
  constructor(private readonly proxy: () => ColabProxy) {}

  async list(): Promise<Cell[]> {
    try {
      const result = await this.proxy().callTool(TOOL_GET_CELLS, {});
      return extractCells(result);
    } catch (err) {
      throw wrapError(err, 'Failed to list cells');
    }
  }

  async createCode(code: string, options: { index?: number } = {}): Promise<Cell> {
    try {
      const result = await this.proxy().callTool(TOOL_ADD_CODE_CELL, {
        cellIndex: options.index ?? 0,
        language: 'python',
        code,
      });
      const cellId = extractCellId(result);
      const cells = await this.list();
      const cell = cells.find((c) => c.cellId === cellId) ?? cells[options.index ?? cells.length - 1];
      if (!cell) {
        return {
          cellId: cellId ?? `cell-${options.index ?? 0}`,
          cellIndex: options.index ?? 0,
          cellType: 'code',
          source: code,
        };
      }
      return cell;
    } catch (err) {
      throw wrapError(err, 'Failed to create code cell');
    }
  }

  async createMarkdown(text: string, options: { index?: number } = {}): Promise<Cell> {
    try {
      const result = await this.proxy().callTool(TOOL_ADD_TEXT_CELL, {
        cellIndex: options.index ?? 0,
        content: text,
      });
      const cellId = extractCellId(result);
      const cells = await this.list();
      const cell = cells.find((c) => c.cellId === cellId) ?? cells[options.index ?? cells.length - 1];
      if (!cell) {
        return {
          cellId: cellId ?? `cell-${options.index ?? 0}`,
          cellIndex: options.index ?? 0,
          cellType: 'text',
          source: text,
        };
      }
      return cell;
    } catch (err) {
      throw wrapError(err, 'Failed to create markdown cell');
    }
  }

  async edit(cellId: string, content: string): Promise<Cell> {
    try {
      await this.proxy().callTool(TOOL_UPDATE_CELL, { cellId, content });
      const cells = await this.list();
      const cell = cells.find((c) => c.cellId === cellId);
      if (!cell) {
        throw new CellNotFoundError(`Cell not found after edit: ${cellId}`);
      }
      return { ...cell, source: content };
    } catch (err) {
      throw wrapError(err, `Failed to edit cell ${cellId}`);
    }
  }

  async remove(cellId: string): Promise<void> {
    try {
      await this.proxy().callTool(TOOL_DELETE_CELL, { cellId });
    } catch (err) {
      throw wrapError(err, `Failed to remove cell ${cellId}`);
    }
  }

  async move(cellId: string, toIndex: number): Promise<void> {
    try {
      await this.proxy().callTool(TOOL_MOVE_CELL, { cellId, cellIndex: toIndex });
    } catch (err) {
      throw wrapError(err, `Failed to move cell ${cellId}`);
    }
  }

  async resolve(ref: string | number): Promise<Cell> {
    const cells = await this.list();
    if (typeof ref === 'number') {
      const cell = cells[ref];
      if (!cell) throw new CellNotFoundError(`No cell at index ${ref}`);
      return cell;
    }
    const cell = cells.find((c) => c.cellId === ref);
    if (!cell) throw new CellNotFoundError(`No cell with id ${ref}`);
    return cell;
  }

  sourceOf(cell: Cell): string {
    return joinSource(cell.source);
  }
}
