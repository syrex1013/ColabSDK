import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CellManager } from '../src/cells/CellManager.js';
import { ExecutionError } from '../src/errors/index.js';
import {
  WorkflowAlreadyLoadedError,
  WorkflowNotFoundError,
  WorkflowNotLoadedError,
  WorkflowExecutionError,
} from '../src/errors/index.js';
import { ExecutionManager } from '../src/execution/ExecutionManager.js';
import { ColabDevPaths } from '../src/storage/ColabDevPaths.js';
import { WorkflowManager } from '../src/workflows/WorkflowManager.js';
import { WorkflowStore } from '../src/workflows/WorkflowStore.js';

function createDeps(tempDir: string) {
  const paths = new ColabDevPaths(tempDir);
  const callTool = vi.fn();
  const listTools = vi.fn().mockResolvedValue([]);
  const proxy = { callTool, listTools, isConnected: true };
  const cells = {
    createCode: vi.fn(),
    createMarkdown: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn(),
    resolve: vi.fn(),
  };
  const execute = {
    runCell: vi.fn(),
    runCode: vi.fn(),
    streamCell: vi.fn(),
    interrupt: vi.fn(),
  };
  const runtime = {
    select: vi.fn().mockResolvedValue(undefined),
  };

  const manager = new WorkflowManager(
    paths,
    () => proxy as never,
    cells as unknown as CellManager,
    execute as unknown as ExecutionManager,
    runtime as never,
  );

  return { manager, paths, proxy, cells, execute, runtime, callTool, listTools };
}

describe('WorkflowManager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colab-wf-mgr-'));
    const store = new WorkflowStore(new ColabDevPaths(tempDir));
    await store.saveDefinition({
      id: 'demo',
      name: 'Demo',
      steps: [
        { type: 'markdown', source: '# Title' },
        { type: 'code', source: 'print("ok")' },
      ],
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists local workflows', async () => {
    const { manager } = createDeps(tempDir);
    const list = await manager.list('local');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo');
    expect(list[0]?.loaded).toBe(false);
  });

  it('loads workflow cells into notebook', async () => {
    const { manager, cells } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });

    const loaded = await manager.load('demo');
    expect(loaded.cellIds).toEqual(['m1', 'c1']);
    expect(cells.createMarkdown).toHaveBeenCalled();
    expect(cells.createCode).toHaveBeenCalled();
  });

  it('throws when loading an already loaded workflow', async () => {
    const { manager, cells } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    await manager.load('demo');
    await expect(manager.load('demo')).rejects.toThrow(WorkflowAlreadyLoadedError);
  });

  it('runs loaded workflow steps', async () => {
    const { manager, cells, execute } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    execute.runCell.mockResolvedValue({
      stdout: 'ok\n',
      stderr: '',
      outputs: [],
      isError: false,
      cellId: 'c1',
    });

    await manager.load('demo');
    const result = await manager.run('demo', { autoLoad: false });
    expect(result.success).toBe(true);
    expect(result.steps.filter((s) => s.type === 'code')).toHaveLength(1);
    expect(execute.runCell).toHaveBeenCalled();
  });

  it('unloads workflow and removes cells', async () => {
    const { manager, cells } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    await manager.load('demo');
    await manager.unload('demo');
    expect(cells.remove).toHaveBeenCalledTimes(2);
    await expect(manager.unload('demo')).rejects.toThrow(WorkflowNotLoadedError);
  });

  it('wraps execution errors as WorkflowExecutionError', async () => {
    const { manager, cells, execute } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    execute.runCell.mockRejectedValue(
      new ExecutionError('boom', { stdout: '', stderr: 'boom', outputs: [], isError: true }),
    );

    await manager.load('demo');
    await expect(manager.run('demo', { autoLoad: false })).rejects.toThrow(WorkflowExecutionError);
  });

  it('streams workflow output', async () => {
    const { manager, cells, execute } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    execute.runCell.mockResolvedValue({
      stdout: 'ok\n',
      stderr: '',
      outputs: [],
      isError: false,
      cellId: 'c1',
    });

    async function* stream() {
      yield { type: 'stdout' as const, text: 'ok\n', timestamp: Date.now() };
      yield { type: 'result' as const, text: 'ok\n', timestamp: Date.now() };
    }
    execute.streamCell.mockReturnValue(stream());

    await manager.load('demo');
    const chunks = [];
    for await (const chunk of manager.runStream('demo', { autoLoad: false })) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.workflowId === 'demo')).toBe(true);
  });

  it('stops running workflow via interrupt', async () => {
    const { manager, execute } = createDeps(tempDir);
    await manager.stop();
    expect(execute.interrupt).toHaveBeenCalled();
  });

  it('uses MCP workflow tools when available', async () => {
    const { manager, listTools, callTool } = createDeps(tempDir);
    listTools.mockResolvedValue([
      { name: 'list_workflows' },
      { name: 'load_workflow' },
      { name: 'unload_workflow' },
      { name: 'run_workflow' },
      { name: 'stop_workflow' },
    ]);
    callTool.mockResolvedValue({
      structuredContent: {
        workflows: [{ id: 'remote-1', name: 'Remote', source: 'uploaded' }],
      },
    });

    const list = await manager.list('uploaded');
    expect(list[0]?.id).toBe('remote-1');
    expect(callTool).toHaveBeenCalledWith('list_workflows', {});
  });

  it('gets and saves workflow definitions', async () => {
    const { manager } = createDeps(tempDir);
    const def = await manager.get('demo');
    expect(def.id).toBe('demo');
    const path = await manager.save({ ...def, name: 'Renamed' });
    expect(path).toContain('demo.json');
  });

  it('uploads workflow file and marks it loaded', async () => {
    const { manager, cells } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    const store = new WorkflowStore(new ColabDevPaths(tempDir));
    const filePath = await store.saveDefinition({
      id: 'upload-me',
      name: 'Upload Me',
      steps: [{ type: 'code', source: 'print(9)' }],
    });

    const info = await manager.upload(filePath, { load: true });
    expect(info.id).toBe('upload-me');
    expect(info.loaded).toBe(true);
  });

  it('auto-loads workflow on run when not loaded', async () => {
    const { manager, cells, execute } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    execute.runCell.mockResolvedValue({
      stdout: 'ok\n',
      stderr: '',
      outputs: [],
      isError: false,
      cellId: 'c1',
    });

    const result = await manager.run('demo');
    expect(result.success).toBe(true);
  });

  it('throws when run without load and autoLoad disabled', async () => {
    const { manager } = createDeps(tempDir);
    await expect(manager.run('demo', { autoLoad: false })).rejects.toThrow(WorkflowNotLoadedError);
  });

  it('delegates MCP load, run, unload, and stop', async () => {
    const { manager, listTools, callTool } = createDeps(tempDir);
    listTools.mockResolvedValue([
      { name: 'list_workflows' },
      { name: 'load_workflow' },
      { name: 'unload_workflow' },
      { name: 'run_workflow' },
      { name: 'stop_workflow' },
    ]);
    callTool.mockImplementation(async (name: string) => {
      if (name === 'load_workflow') {
        return { structuredContent: { workflowId: 'remote', cellIds: ['c1'] } };
      }
      if (name === 'run_workflow') {
        return { structuredContent: { steps: [], isError: false } };
      }
      return { structuredContent: {} };
    });

    const loaded = await manager.load('remote');
    expect(loaded.id).toBe('remote');
    await manager.run('remote');
    await manager.unload('remote');
    await manager.stop();
    expect(callTool).toHaveBeenCalledWith('load_workflow', expect.any(Object));
    expect(callTool.mock.calls.some((call) => call[0] === 'run_workflow')).toBe(true);
  });

  it('throws WorkflowNotFoundError for missing workflow', async () => {
    const { manager } = createDeps(tempDir);
    await expect(manager.get('missing')).rejects.toThrow(WorkflowNotFoundError);
  });

  it('lists all workflows including loaded registry entries', async () => {
    const { manager, cells } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    await manager.load('demo');
    const all = await manager.list('all');
    expect(all.some((w) => w.id === 'demo' && w.loaded)).toBe(true);
  });

  it('uploads without loading when load is false', async () => {
    const { manager } = createDeps(tempDir);
    const store = new WorkflowStore(new ColabDevPaths(tempDir));
    const filePath = await store.saveDefinition({
      id: 'register-only',
      name: 'Register Only',
      steps: [{ type: 'code', source: 'print(1)' }],
    });
    const info = await manager.upload(filePath, { load: false });
    expect(info.loaded).toBe(false);
  });

  it('streams via MCP workflow tools', async () => {
    const { manager, listTools, callTool } = createDeps(tempDir);
    listTools.mockResolvedValue([
      { name: 'list_workflows' },
      { name: 'load_workflow' },
      { name: 'unload_workflow' },
      { name: 'run_workflow' },
      { name: 'stop_workflow' },
    ]);
    callTool.mockResolvedValue({
      structuredContent: {
        chunks: [{ stepIndex: 0, stepType: 'code', type: 'stdout', text: 'ok', timestamp: 1 }],
        isError: false,
      },
    });

    const chunks = [];
    for await (const chunk of manager.runStream('remote')) {
      chunks.push(chunk);
    }
    expect(chunks[0]?.text).toBe('ok');
    expect(callTool).toHaveBeenCalledWith(
      'run_workflow',
      { workflowId: 'remote', stream: true },
      300_000,
    );
  });

  it('selects GPU when loading workflow with gpu option', async () => {
    const { manager, cells, runtime } = createDeps(tempDir);
    cells.createMarkdown.mockResolvedValue({ cellId: 'm1' });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    await manager.load('demo', { gpu: 't4' });
    expect(runtime.select).toHaveBeenCalledWith('t4');
  });

  it('skips empty code steps marked skipIfEmpty', async () => {
    const { manager, cells, execute } = createDeps(tempDir);
    const store = new WorkflowStore(new ColabDevPaths(tempDir));
    await store.saveDefinition({
      id: 'sparse',
      name: 'Sparse',
      steps: [
        { type: 'code', source: '   ', skipIfEmpty: true },
        { type: 'code', source: 'print(1)' },
      ],
    });
    cells.createCode.mockResolvedValue({ cellId: 'c1' });
    execute.runCell.mockResolvedValue({
      stdout: '1\n',
      stderr: '',
      outputs: [],
      isError: false,
      cellId: 'c1',
    });

    await manager.load('sparse');
    const result = await manager.run('sparse', { autoLoad: false });
    expect(result.steps.filter((s) => s.skipped)).toHaveLength(1);
    expect(execute.runCell).toHaveBeenCalledTimes(1);
  });

  it('lists uploaded registry entries without local definitions', async () => {
    const { manager } = createDeps(tempDir);
    const store = new WorkflowStore(new ColabDevPaths(tempDir));
    await store.setLoaded({
      id: 'orphan',
      source: 'uploaded',
      loadedAt: new Date().toISOString(),
      cellIds: ['c9'],
    });
    const uploaded = await manager.list('uploaded');
    expect(uploaded.some((w) => w.id === 'orphan')).toBe(true);
  });

  it('falls back to cell execution when MCP list tools are incomplete', async () => {
    const { manager, listTools } = createDeps(tempDir);
    listTools.mockResolvedValue([{ name: 'list_workflows' }]);
    const list = await manager.list('local');
    expect(list.some((w) => w.id === 'demo')).toBe(true);
  });

  it('uses local listing when MCP tools exist but filter is local', async () => {
    const { manager, listTools, callTool } = createDeps(tempDir);
    listTools.mockResolvedValue([
      { name: 'list_workflows' },
      { name: 'load_workflow' },
      { name: 'unload_workflow' },
      { name: 'run_workflow' },
      { name: 'stop_workflow' },
    ]);
    callTool.mockResolvedValue({
      structuredContent: { workflows: [{ id: 'remote', source: 'uploaded' }] },
    });
    const list = await manager.list('local');
    expect(list.some((w) => w.id === 'demo')).toBe(true);
    expect(list.some((w) => w.id === 'remote')).toBe(false);
  });

  it('throws WorkflowExecutionError when MCP stream reports failure', async () => {
    const { manager, listTools, callTool } = createDeps(tempDir);
    listTools.mockResolvedValue([
      { name: 'list_workflows' },
      { name: 'load_workflow' },
      { name: 'unload_workflow' },
      { name: 'run_workflow' },
      { name: 'stop_workflow' },
    ]);
    callTool.mockResolvedValue({
      structuredContent: { isError: true, error: 'stream failed' },
      isError: true,
    });

    await expect(async () => {
      for await (const _chunk of manager.runStream('remote')) {
        // drain
      }
    }).rejects.toThrow(WorkflowExecutionError);
  });
});
