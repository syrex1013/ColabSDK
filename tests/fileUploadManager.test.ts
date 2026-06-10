import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CellManager } from '../src/cells/CellManager.js';
import { FileUploadError, UploadWidgetNotFoundError } from '../src/errors/index.js';
import { FileUploadManager } from '../src/files/FileUploadManager.js';
import { TOOL_RUN_CODE_CELL } from '../src/constants.js';

function createDeps() {
  const callTool = vi.fn();
  const proxy = { callTool, isConnected: true };
  const cells = {
    resolve: vi.fn(),
    list: vi.fn(),
    createCode: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    ensureRuntimeConnected: vi.fn().mockResolvedValue(undefined),
    readCellUploadState: vi.fn(),
    waitForCellFileInput: vi.fn().mockResolvedValue(undefined),
    setCellUploadFiles: vi.fn().mockResolvedValue(undefined),
    runCellViaBrowser: vi.fn().mockResolvedValue(undefined),
    interruptExecution: vi.fn().mockResolvedValue(undefined),
  };

  const manager = new FileUploadManager(
    () => proxy as never,
    cells as unknown as CellManager,
    browser as never,
  );

  return { manager, proxy, cells, browser, callTool };
}

describe('FileUploadManager', () => {
  let tempDir: string;
  let sampleFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colab-upload-'));
    sampleFile = join(tempDir, 'sample.txt');
    await writeFile(sampleFile, 'hello-upload');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('finds upload cells', async () => {
    const { manager, cells } = createDeps();
    cells.list.mockResolvedValue([
      { cellId: 'u1', cellIndex: 0, cellType: 'code', source: 'files.upload()' },
      { cellId: 'x1', cellIndex: 1, cellType: 'code', source: 'print(1)' },
    ]);

    const found = await manager.findUploadCells();
    expect(found).toHaveLength(1);
    expect(found[0]?.cellId).toBe('u1');
  });

  it('uploads files to a cell and waits for completion', async () => {
    const { manager, cells, browser } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'u1',
      cellIndex: 0,
      cellType: 'code',
      source: 'from google.colab import files\nfiles.upload()',
    });
    browser.readCellUploadState
      .mockResolvedValueOnce({ hasFileInput: false, fileInputCount: 0, uploadedFileNames: [], complete: false })
      .mockResolvedValueOnce({ hasFileInput: true, fileInputCount: 1, uploadedFileNames: [], complete: false })
      .mockResolvedValue({ hasFileInput: false, fileInputCount: 0, uploadedFileNames: ['sample.txt'], complete: true });
    cells.list.mockResolvedValue([
      {
        cellId: 'u1',
        cellIndex: 0,
        cellType: 'code',
        source: 'files.upload()',
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['done\n'] }],
      },
    ]);

    const progress: string[] = [];
    const result = await manager.upload('u1', sampleFile, {
      onProgress: (e) => progress.push(e.phase),
    });

    expect(result.method).toBe('widget');
    expect(result.files).toEqual([sampleFile]);
    expect(browser.runCellViaBrowser).toHaveBeenCalledWith('u1', 0);
    expect(browser.setCellUploadFiles).toHaveBeenCalledWith('u1', 0, [sampleFile]);
    expect(progress).toContain('uploading');
    expect(progress).toContain('complete');
  });

  it('rejects cells without upload widgets when runCell is enabled', async () => {
    const { manager, cells } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'x1',
      cellIndex: 0,
      cellType: 'code',
      source: 'print(1)',
    });

    await expect(manager.upload('x1', sampleFile)).rejects.toThrow(FileUploadError);
  });

  it('streams upload progress events', async () => {
    const { manager, cells, browser } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'u1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    });
    browser.readCellUploadState
      .mockResolvedValueOnce({ hasFileInput: false, fileInputCount: 0, uploadedFileNames: [], complete: false })
      .mockResolvedValue({ hasFileInput: false, fileInputCount: 0, uploadedFileNames: ['sample.txt'], complete: true });
    cells.list.mockResolvedValue([
      {
        cellId: 'u1',
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['done\n'] }],
      },
    ]);

    const phases: string[] = [];
    for await (const event of manager.watchUpload('u1', sampleFile)) {
      phases.push(event.phase);
    }
    expect(phases).toContain('complete');
  });

  it('times out when upload never completes and runtime fallback is disabled', async () => {
    const { manager, cells, browser } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'u1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    });
    browser.readCellUploadState.mockResolvedValue({
      hasFileInput: true,
      fileInputCount: 1,
      uploadedFileNames: [],
      complete: false,
    });

    await expect(
      manager.upload('u1', sampleFile, {
        uploadTimeoutMs: 50,
        widgetTimeoutMs: 10,
        runtimeFallback: false,
      }),
    ).rejects.toThrow(FileUploadError);
  });

  it('falls back to runtime upload when widget is not found', async () => {
    const { manager, cells, browser, callTool } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'u1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    });
    browser.readCellUploadState.mockResolvedValue({
      hasFileInput: false,
      fileInputCount: 0,
      uploadedFileNames: [],
      complete: false,
    });
    browser.waitForCellFileInput.mockRejectedValue(new UploadWidgetNotFoundError('u1'));
    callTool.mockResolvedValue({
      structuredContent: {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['/content/sample.txt\n'] }],
        isError: false,
      },
    });
    cells.createCode.mockResolvedValue({ cellId: 'temp1', cellIndex: 1, cellType: 'code', source: '' });

    const result = await manager.upload('u1', sampleFile);

    expect(result.method).toBe('runtime');
    expect(result.remotePaths).toEqual(['/content/sample.txt']);
    expect(browser.runCellViaBrowser).toHaveBeenCalledWith('u1', 0);
    expect(browser.interruptExecution).toHaveBeenCalled();
    expect(cells.createCode).toHaveBeenCalled();
    expect(cells.remove).toHaveBeenCalledWith('temp1');
    expect(callTool).toHaveBeenCalledWith(TOOL_RUN_CODE_CELL, { cellId: 'temp1' }, 300_000);
  });

  it('surfaces widget not found when runtime fallback is disabled', async () => {
    const { manager, cells, browser } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'u1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    });
    browser.readCellUploadState.mockResolvedValue({
      hasFileInput: false,
      fileInputCount: 0,
      uploadedFileNames: [],
      complete: false,
    });
    browser.waitForCellFileInput.mockRejectedValue(new UploadWidgetNotFoundError('u1'));

    await expect(manager.upload('u1', sampleFile, { runtimeFallback: false })).rejects.toThrow(
      UploadWidgetNotFoundError,
    );
  });

  it('throws when runtime upload cell execution fails', async () => {
    const { manager, cells, callTool } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'x1',
      cellIndex: 0,
      cellType: 'code',
      source: 'print(1)',
    });
    cells.createCode.mockResolvedValue({ cellId: 'temp1', cellIndex: 1, cellType: 'code', source: '' });
    callTool.mockResolvedValue({
      structuredContent: {
        outputs: [{ output_type: 'error', ename: 'Error', evalue: 'boom', traceback: ['boom'] }],
        isError: true,
      },
    });

    await expect(manager.upload('x1', sampleFile, { runtimeOnly: true })).rejects.toThrow(FileUploadError);
    expect(cells.remove).toHaveBeenCalledWith('temp1');
  });

  it('surfaces runtime fallback errors after widget failure', async () => {
    const { manager, cells, browser, callTool } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'u1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    });
    browser.readCellUploadState.mockResolvedValue({
      hasFileInput: false,
      fileInputCount: 0,
      uploadedFileNames: [],
      complete: false,
    });
    browser.waitForCellFileInput.mockRejectedValue(new UploadWidgetNotFoundError('u1'));
    cells.createCode.mockResolvedValue({ cellId: 'temp1', cellIndex: 1, cellType: 'code', source: '' });
    callTool.mockRejectedValue(new Error('runtime down'));

    await expect(manager.upload('u1', sampleFile)).rejects.toThrow('runtime down');
  });

  it('uploads via runtime when runtimeOnly is set', async () => {
    const { manager, cells, callTool } = createDeps();
    cells.resolve.mockResolvedValue({
      cellId: 'x1',
      cellIndex: 0,
      cellType: 'code',
      source: 'print(1)',
    });
    cells.createCode.mockResolvedValue({ cellId: 'temp1', cellIndex: 1, cellType: 'code', source: '' });
    callTool.mockResolvedValue({
      structuredContent: {
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['/content/sample.txt\n'] }],
        isError: false,
      },
    });

    const result = await manager.upload('x1', sampleFile, { runtimeOnly: true });

    expect(result.method).toBe('runtime');
    expect(result.remotePaths).toEqual(['/content/sample.txt']);
  });
});
