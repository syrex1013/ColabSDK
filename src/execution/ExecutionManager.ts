import { STREAM_POLL_INTERVAL_MS, TOOL_RUN_CODE_CELL } from '../constants.js';
import {
  ExecutionError,
  ExecutionInterruptedError,
  wrapError,
} from '../errors/index.js';
import type { CellManager } from '../cells/CellManager.js';
import { parseCellResult } from '../cells/cellUtils.js';
import type { BrowserSession } from '../browser/BrowserSession.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { CellResult, OutputChunk } from '../types/index.js';

export class ExecutionManager {
  private interrupted = false;

  constructor(
    private readonly proxy: () => ColabProxy,
    private readonly cells: CellManager,
    private readonly browser: BrowserSession,
  ) {}

  async runCell(ref: string | number): Promise<CellResult> {
    try {
      this.interrupted = false;
      const cell = await this.cells.resolve(ref);

      let result: Record<string, unknown> | null = null;
      let lastError: unknown;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.browser.ensureRuntimeConnected(90_000);
          result = await this.proxy().callTool(TOOL_RUN_CODE_CELL, { cellId: cell.cellId }, 180_000);
          break;
        } catch (err) {
          lastError = err;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }

      if (!result) {
        throw lastError;
      }
      const parsed = parseCellResult(result);
      const cellResult: CellResult = {
        ...parsed,
        cellId: cell.cellId,
      };

      if (cellResult.isError) {
        throw new ExecutionError(cellResult.stderr || cellResult.stdout || 'Cell execution failed', cellResult);
      }

      return cellResult;
    } catch (err) {
      if (this.interrupted) {
        throw new ExecutionInterruptedError(undefined, err);
      }
      throw wrapError(err, 'Failed to run cell');
    }
  }

  async runCode(code: string, options: { cleanup?: boolean; index?: number } = {}): Promise<CellResult> {
    const cell = await this.cells.createCode(code, { index: options.index });
    try {
      return await this.runCell(cell.cellId);
    } finally {
      if (options.cleanup) {
        await this.cells.remove(cell.cellId).catch(() => {});
      }
    }
  }

  async runAll(): Promise<CellResult[]> {
    const cells = await this.cells.list();
    const results: CellResult[] = [];
    for (const cell of cells) {
      if (cell.cellType !== 'code' || !cell.source.trim()) continue;
      results.push(await this.runCell(cell.cellId));
    }
    return results;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    try {
      await this.browser.interruptExecution();
    } catch (err) {
      throw wrapError(err, 'Failed to interrupt execution');
    }
  }

  async *streamCell(ref: string | number): AsyncGenerator<OutputChunk> {
    const cell = await this.cells.resolve(ref);
    let lastStdout = '';
    let lastStderr = '';
    let done = false;

    const runPromise = this.proxy()
      .callTool(TOOL_RUN_CODE_CELL, { cellId: cell.cellId })
      .then((result) => {
        done = true;
        return result;
      });

    while (!done) {
      await new Promise((r) => setTimeout(r, STREAM_POLL_INTERVAL_MS));
      const cells = await this.cells.list();
      const current = cells.find((c) => c.cellId === cell.cellId);
      const outputs = current?.outputs ?? [];
      const snapshot = JSON.stringify(outputs);
      if (snapshot !== JSON.stringify(cell.outputs)) {
        yield {
          type: 'stdout',
          text: snapshot,
          timestamp: Date.now(),
        };
      }
    }

    const result = await runPromise;
    const parsed = parseCellResult(result);

    if (parsed.stdout.length > lastStdout.length) {
      yield {
        type: 'stdout',
        text: parsed.stdout.slice(lastStdout.length),
        timestamp: Date.now(),
      };
      lastStdout = parsed.stdout;
    }

    if (parsed.stderr.length > lastStderr.length) {
      yield {
        type: 'stderr',
        text: parsed.stderr.slice(lastStderr.length),
        timestamp: Date.now(),
      };
      lastStderr = parsed.stderr;
    }

    yield {
      type: parsed.isError ? 'error' : 'result',
      text: parsed.isError ? parsed.stderr || parsed.stdout : parsed.stdout,
      timestamp: Date.now(),
    };

    if (parsed.isError) {
      throw new ExecutionError(parsed.stderr || parsed.stdout || 'Cell execution failed', parsed);
    }
  }
}
