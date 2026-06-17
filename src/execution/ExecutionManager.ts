import { STREAM_POLL_INTERVAL_MS, TOOL_RUN_CODE_CELL } from '../constants.js';
import {
  ExecutionError,
  ExecutionInterruptedError,
  wrapError,
} from '../errors/index.js';
import type { CellManager } from '../cells/CellManager.js';
import { parseCellResult, outputsToText, hasErrorOutput } from '../cells/cellUtils.js';
import type { BrowserSession } from '../browser/BrowserSession.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { CellResult, OutputChunk } from '../types/index.js';

export interface StreamCellOptions {
  timeoutMs?: number;
  heartbeatMs?: number;
}

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

  async *streamCell(
    ref: string | number,
    options: StreamCellOptions = {},
  ): AsyncGenerator<OutputChunk> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    const cell = await this.cells.resolve(ref);

    let isDone = false;
    let mcpLastText = '';
    let domBaseLen = 0;
    let domLastLen = 0;
    const pollStart = Date.now();
    let lastHeartbeat = pollStart;

    const page = this.browser.activePage;
    if (page) {
      const baseline = await this.browser.readPageText();
      domBaseLen = baseline.length;
      domLastLen = baseline.length;
    }

    const execPromise = this.proxy()
      .callTool(TOOL_RUN_CODE_CELL, { cellId: cell.cellId }, timeoutMs)
      .then((r) => ({ ok: true as const, result: r }))
      .catch((e: unknown) => ({ ok: false as const, error: e }));

    execPromise.then(() => { isDone = true; }).catch(() => { isDone = true; });

    while (!isDone) {
      await new Promise((r) => setTimeout(r, STREAM_POLL_INTERVAL_MS));

      try {
        const cells = await this.cells.list();
        const current = cells.find((c) => c.cellId === cell.cellId);
        const mcpText = outputsToText(current?.outputs);

        if (mcpText.length > mcpLastText.length) {
          yield { type: 'stdout', text: mcpText.slice(mcpLastText.length), timestamp: Date.now() };
          mcpLastText = mcpText;
        } else if (!mcpText && page) {
          const pageText = await this.browser.readPageText();
          if (pageText.length > domLastLen) {
            const chunk = pageText.slice(domLastLen);
            domLastLen = pageText.length;
            if (chunk.trim()) {
              yield { type: 'stdout', text: chunk, timestamp: Date.now() };
            }
          }
        }
      } catch { /* ignore transient errors */ }

      const now = Date.now();
      if (now - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = now;
        const elapsed = Math.round((now - pollStart) / 1000);
        yield { type: 'stdout', text: `[cell running… ${elapsed}s]\n`, timestamp: now };
      }
    }

    const done = await execPromise;
    const usedDomFallback = domLastLen > domBaseLen;

    if (done.ok) {
      const resultOutputs =
        (done.result as { structuredContent?: { outputs?: unknown[] } }).structuredContent?.outputs ?? [];

      if (!usedDomFallback) {
        const resultText = outputsToText(resultOutputs);
        if (resultText.length > mcpLastText.length) {
          yield { type: 'stdout', text: resultText.slice(mcpLastText.length), timestamp: Date.now() };
          mcpLastText = resultText;
        }
        try {
          const cells = await this.cells.list();
          const current = cells.find((c) => c.cellId === cell.cellId);
          const fallbackText = outputsToText(current?.outputs);
          if (fallbackText.length > mcpLastText.length) {
            yield { type: 'stdout', text: fallbackText.slice(mcpLastText.length), timestamp: Date.now() };
            mcpLastText = fallbackText;
          }
          if (hasErrorOutput(current?.outputs)) {
            throw new ExecutionError('Cell execution failed', {
              stdout: mcpLastText, stderr: '', outputs: current?.outputs ?? [], isError: true,
            });
          }
        } catch (e) {
          if (e instanceof ExecutionError) throw e;
        }
        if (hasErrorOutput(resultOutputs)) {
          throw new ExecutionError('Cell execution failed', {
            stdout: mcpLastText, stderr: '', outputs: resultOutputs, isError: true,
          });
        }
      } else {
        // DOM fallback was used — skip re-yielding full MCP output to avoid duplicates.
        // Just check for error outputs.
        if (hasErrorOutput(resultOutputs)) {
          throw new ExecutionError('Cell execution failed', {
            stdout: '', stderr: '', outputs: resultOutputs, isError: true,
          });
        }
        try {
          const cells = await this.cells.list();
          const current = cells.find((c) => c.cellId === cell.cellId);
          if (hasErrorOutput(current?.outputs)) {
            throw new ExecutionError('Cell execution failed', {
              stdout: '', stderr: '', outputs: current?.outputs ?? [], isError: true,
            });
          }
        } catch (e) {
          if (e instanceof ExecutionError) throw e;
        }
      }

      yield { type: 'result', text: mcpLastText, timestamp: Date.now() };
    } else {
      const err = (done as { ok: false; error: unknown }).error;
      throw err instanceof Error ? err : new ExecutionError('Cell execution failed');
    }
  }
}
