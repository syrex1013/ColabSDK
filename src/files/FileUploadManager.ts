import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { STREAM_POLL_INTERVAL_MS, TOOL_RUN_CODE_CELL } from '../constants.js';
import {
  FileUploadError,
  UploadWidgetNotFoundError,
  wrapError,
} from '../errors/index.js';
import type { CellManager } from '../cells/CellManager.js';
import { parseCellResult } from '../cells/cellUtils.js';
import type { BrowserSession } from '../browser/BrowserSession.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { CellResult } from '../types/index.js';
import {
  cellHasFileUpload,
  describeUploadCell,
  type UploadCellInfo,
} from './cellUploadUtils.js';
import { buildRuntimeUploadScript, readFileAsBase64Chunks } from './runtimeUpload.js';

export interface FileUploadOptions {
  /** Max time to wait for the upload widget after starting the cell (ms). */
  widgetTimeoutMs?: number;
  /** Max time to wait for upload completion after files are set (ms). */
  uploadTimeoutMs?: number;
  /** Run the cell if it is not already waiting on an upload widget. Default: true */
  runCell?: boolean;
  /** Fall back to writing files into `/content` when the browser widget is unavailable. Default: true */
  runtimeFallback?: boolean;
  /** Skip widget flow and upload directly to the runtime. */
  runtimeOnly?: boolean;
  onProgress?: (event: UploadProgressEvent) => void;
}

export interface UploadProgressEvent {
  phase: 'starting' | 'waiting' | 'uploading' | 'processing' | 'complete' | 'error';
  cellId: string;
  percent?: number;
  bytesUploaded?: number;
  bytesTotal?: number;
  fileName?: string;
  fileNames?: string[];
  message?: string;
  method?: 'widget' | 'runtime';
  timestamp: number;
}

export interface FileUploadResult {
  cellId: string;
  files: string[];
  bytesTotal: number;
  method: 'widget' | 'runtime';
  remotePaths?: string[];
  cellResult?: CellResult;
}

export class FileUploadManager {
  constructor(
    private readonly proxy: () => ColabProxy,
    private readonly cells: CellManager,
    private readonly browser: BrowserSession,
  ) {}

  async findUploadCells(): Promise<UploadCellInfo[]> {
    try {
      const cells = await this.cells.list();
      return cells
        .map((cell) => describeUploadCell(cell))
        .filter((info): info is UploadCellInfo => info !== null);
    } catch (err) {
      throw wrapError(err, 'Failed to find upload cells');
    }
  }

  async upload(
    ref: string | number,
    filePaths: string | string[],
    options: FileUploadOptions = {},
  ): Promise<FileUploadResult> {
    const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((p) => resolve(p));
    const cell = await this.cells.resolve(ref);

    if (!cellHasFileUpload(cell) && options.runCell !== false && !options.runtimeOnly) {
      throw new FileUploadError(
        `Cell ${cell.cellId} does not appear to contain a file upload. ` +
          'Add google.colab.files.upload() or pass runtimeOnly: true.',
        cell.cellId,
      );
    }

    const bytesTotal = await this.totalBytes(files);
    const emit = (event: Omit<UploadProgressEvent, 'cellId' | 'timestamp'>) => {
      options.onProgress?.({
        ...event,
        cellId: cell.cellId,
        timestamp: Date.now(),
      });
    };

    emit({
      phase: 'starting',
      fileNames: files.map((f) => f.split('/').pop() ?? f),
      bytesTotal,
    });

    if (options.runtimeOnly) {
      return this.uploadViaRuntime(cell.cellId, files, bytesTotal, emit);
    }

    let startedCellInBrowser = false;

    try {
      return await this.uploadViaWidget(cell, files, bytesTotal, emit, options, () => {
        startedCellInBrowser = true;
      });
    } catch (err) {
      const useFallback =
        options.runtimeFallback !== false &&
        (err instanceof UploadWidgetNotFoundError ||
          (err instanceof FileUploadError && err.message.includes('Timed out')));

      if (!useFallback) {
        emit({ phase: 'error', message: err instanceof Error ? err.message : 'Upload failed' });
        throw err;
      }

      if (startedCellInBrowser) {
        await this.browser.interruptExecution().catch(() => {});
      }

      emit({
        phase: 'waiting',
        message: 'Widget unavailable; uploading via Colab runtime',
        method: 'runtime',
      });

      try {
        return await this.uploadViaRuntime(cell.cellId, files, bytesTotal, emit);
      } catch (fallbackErr) {
        emit({
          phase: 'error',
          message: fallbackErr instanceof Error ? fallbackErr.message : 'Upload failed',
        });
        throw fallbackErr;
      }
    }
  }

  async *watchUpload(
    ref: string | number,
    filePaths: string | string[],
    options: Omit<FileUploadOptions, 'onProgress'> = {},
  ): AsyncGenerator<UploadProgressEvent> {
    const queue: UploadProgressEvent[] = [];
    let done = false;

    const uploadPromise = this.upload(ref, filePaths, {
      ...options,
      onProgress: (event) => queue.push(event),
    }).finally(() => {
      done = true;
    });

    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise((r) => setTimeout(r, STREAM_POLL_INTERVAL_MS / 2));
      }
    }

    await uploadPromise;
  }

  private async uploadViaWidget(
    cell: { cellId: string; cellIndex: number },
    files: string[],
    bytesTotal: number,
    emit: (event: Omit<UploadProgressEvent, 'cellId' | 'timestamp'>) => void,
    options: FileUploadOptions,
    onCellStarted: () => void,
  ): Promise<FileUploadResult> {
    const widgetTimeoutMs = options.widgetTimeoutMs ?? 120_000;
    const uploadTimeoutMs = options.uploadTimeoutMs ?? 300_000;

    const waiting = await this.browser.readCellUploadState(cell.cellId, cell.cellIndex);

    if (!waiting.hasFileInput && options.runCell !== false) {
      await this.browser.ensureRuntimeConnected(90_000);
      await this.browser.runCellViaBrowser(cell.cellId, cell.cellIndex);
      onCellStarted();
    }

    emit({ phase: 'waiting', message: 'Waiting for file upload widget', method: 'widget' });
    await this.browser.waitForCellFileInput(cell.cellId, cell.cellIndex, widgetTimeoutMs);

    emit({ phase: 'uploading', percent: 0, bytesUploaded: 0, bytesTotal, method: 'widget' });
    await this.browser.setCellUploadFiles(cell.cellId, cell.cellIndex, files);

    const completed = await this.waitForUploadComplete(
      cell.cellId,
      cell.cellIndex,
      uploadTimeoutMs,
      bytesTotal,
      emit,
      'widget',
    );

    if (!completed) {
      throw new FileUploadError('Timed out waiting for file upload to complete', cell.cellId);
    }

    emit({
      phase: 'processing',
      percent: 100,
      bytesUploaded: bytesTotal,
      bytesTotal,
      message: 'Waiting for cell execution to finish',
      method: 'widget',
    });

    const cellResult = await this.waitForCellExecution(cell.cellId, uploadTimeoutMs, cell.cellIndex);
    if (cellResult?.isError) {
      throw new FileUploadError(
        cellResult.stderr || cellResult.stdout || 'Cell failed after file upload',
        cell.cellId,
        cellResult,
      );
    }

    emit({
      phase: 'complete',
      percent: 100,
      bytesUploaded: bytesTotal,
      bytesTotal,
      fileNames: files.map((f) => f.split('/').pop() ?? f),
      method: 'widget',
    });

    return { cellId: cell.cellId, files, bytesTotal, method: 'widget', cellResult };
  }

  private async uploadViaRuntime(
    cellId: string,
    files: string[],
    bytesTotal: number,
    emit: (event: Omit<UploadProgressEvent, 'cellId' | 'timestamp'>) => void,
  ): Promise<FileUploadResult> {
    await this.browser.ensureRuntimeConnected(90_000);
    const remotePaths: string[] = [];
    let bytesUploaded = 0;

    emit({
      phase: 'uploading',
      percent: 0,
      bytesUploaded: 0,
      bytesTotal,
      method: 'runtime',
      message: 'Writing files to /content',
    });

    for (const filePath of files) {
      const { remoteName, chunks, size } = await readFileAsBase64Chunks(filePath);
      const tempCell = await this.cells.createCode(buildRuntimeUploadScript(remoteName, chunks));

      try {
        const result = await this.proxy().callTool(
          TOOL_RUN_CODE_CELL,
          { cellId: tempCell.cellId },
          300_000,
        );
        const parsed = parseCellResult(result);
        if (parsed.isError) {
          throw new FileUploadError(
            parsed.stderr || parsed.stdout || `Runtime upload failed for ${remoteName}`,
            cellId,
            parsed,
          );
        }

        const remotePath = parsed.stdout.trim().split('\n').pop() ?? `/content/${remoteName}`;
        remotePaths.push(remotePath);
        bytesUploaded += size;

        emit({
          phase: 'uploading',
          percent: Math.min(100, Math.round((bytesUploaded / bytesTotal) * 100)),
          bytesUploaded,
          bytesTotal,
          fileName: remoteName,
          method: 'runtime',
        });
      } finally {
        await this.cells.remove(tempCell.cellId).catch(() => {});
      }
    }

    emit({
      phase: 'complete',
      percent: 100,
      bytesUploaded: bytesTotal,
      bytesTotal,
      fileNames: files.map((f) => f.split('/').pop() ?? f),
      method: 'runtime',
      message: `Uploaded to ${remotePaths.join(', ')}`,
    });

    return {
      cellId,
      files,
      bytesTotal,
      method: 'runtime',
      remotePaths,
    };
  }

  private async waitForCellExecution(
    cellId: string,
    timeoutMs: number,
    cellIndex?: number,
  ): Promise<CellResult | undefined> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Primary: notebook model outputs via MCP (may lag or fail while the
      // upload widget holds the kernel; tolerate errors and keep polling)
      const cells = await this.cells.list().catch(() => null);
      if (cells) {
        const cell = cells.find((entry) => entry.cellId === cellId);
        const outputs = cell?.outputs ?? [];
        if (outputs.length) {
          const parsed = parseCellResult({ structuredContent: { outputs } });
          const finished = outputs.some((output) => {
            const typed = output as { output_type?: string };
            return (
              typed.output_type === 'stream' ||
              typed.output_type === 'execute_result' ||
              typed.output_type === 'error'
            );
          });

          if (finished) {
            return { ...parsed, cellId };
          }
        }
      }

      // Fallback: the cell output renders in a sandboxed output iframe that the
      // notebook model may not reflect promptly. If the DOM shows the upload
      // cell printed its result (e.g. `uploaded: [...]`), treat it as finished.
      if (cellIndex !== undefined) {
        const domState = await this.browser
          .readCellUploadState(cellId, cellIndex)
          .catch(() => null);
        if (domState?.complete) {
          return undefined;
        }
      }

      await new Promise((r) => setTimeout(r, STREAM_POLL_INTERVAL_MS));
    }

    return undefined;
  }

  private async totalBytes(files: string[]): Promise<number> {
    let total = 0;
    for (const file of files) {
      const info = await stat(file);
      total += info.size;
    }
    return total;
  }

  private async waitForUploadComplete(
    cellId: string,
    cellIndex: number,
    timeoutMs: number,
    bytesTotal: number,
    emit: (event: Omit<UploadProgressEvent, 'cellId' | 'timestamp'>) => void,
    method: 'widget' | 'runtime',
  ): Promise<boolean> {
    const start = Date.now();
    let lastPercent = 0;

    while (Date.now() - start < timeoutMs) {
      const state = await this.browser.readCellUploadState(cellId, cellIndex);

      if (state.progressPercent !== undefined && state.progressPercent > lastPercent) {
        lastPercent = state.progressPercent;
        emit({
          phase: 'uploading',
          percent: state.progressPercent,
          bytesUploaded: Math.round((bytesTotal * state.progressPercent) / 100),
          bytesTotal,
          message: state.statusText,
          fileNames: state.uploadedFileNames,
          method,
        });
      } else if (state.uploadedFileNames.length) {
        emit({
          phase: 'uploading',
          percent: lastPercent || undefined,
          bytesUploaded: lastPercent ? Math.round((bytesTotal * lastPercent) / 100) : undefined,
          bytesTotal,
          fileNames: state.uploadedFileNames,
          message: state.statusText,
          method,
        });
      }

      if (state.complete || (!state.hasFileInput && state.uploadedFileNames.length > 0)) {
        return true;
      }

      await new Promise((r) => setTimeout(r, STREAM_POLL_INTERVAL_MS));
    }

    return false;
  }
}
