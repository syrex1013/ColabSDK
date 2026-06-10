import {
  TOOL_LIST_WORKFLOWS,
  TOOL_LOAD_WORKFLOW,
  TOOL_UNLOAD_WORKFLOW,
  TOOL_RUN_WORKFLOW,
  TOOL_STOP_WORKFLOW,
} from '../constants.js';
import {
  ExecutionError,
  WorkflowAlreadyLoadedError,
  WorkflowExecutionError,
  WorkflowNotFoundError,
  WorkflowNotLoadedError,
  wrapError,
} from '../errors/index.js';
import type { CellManager } from '../cells/CellManager.js';
import type { ExecutionManager } from '../execution/ExecutionManager.js';
import type { ColabProxy } from '../proxy/ColabProxy.js';
import type { RuntimeManager } from '../runtime/RuntimeManager.js';
import type { ColabDevPaths } from '../storage/ColabDevPaths.js';
import type { CellResult, OutputChunk, RuntimeType } from '../types/index.js';
import { WorkflowStore } from './WorkflowStore.js';
import type { LoadedWorkflow, WorkflowDefinition } from './workflowSchema.js';
import { isCodeStep, parseWorkflowListResult } from './workflowUtils.js';

export type WorkflowSourceFilter = 'all' | 'local' | 'uploaded';

export interface WorkflowInfo {
  id: string;
  name: string;
  description?: string;
  source: 'local' | 'uploaded';
  loaded: boolean;
  stepCount: number;
  path?: string;
}

export interface WorkflowRunOptions {
  autoLoad?: boolean;
  gpu?: RuntimeType;
}

export interface WorkflowStepResult {
  stepIndex: number;
  type: 'code' | 'markdown';
  cellId?: string;
  skipped?: boolean;
  result?: CellResult;
}

export interface WorkflowRunResult {
  workflowId: string;
  steps: WorkflowStepResult[];
  success: boolean;
}

export interface WorkflowStreamChunk extends OutputChunk {
  workflowId: string;
  stepIndex: number;
  stepType: 'code' | 'markdown';
}

const WORKFLOW_MCP_TOOLS = [
  TOOL_LIST_WORKFLOWS,
  TOOL_LOAD_WORKFLOW,
  TOOL_UNLOAD_WORKFLOW,
  TOOL_RUN_WORKFLOW,
  TOOL_STOP_WORKFLOW,
] as const;

export class WorkflowManager {
  private readonly store: WorkflowStore;
  private runningWorkflowId: string | null = null;
  private mcpWorkflowToolsAvailable: boolean | null = null;

  constructor(
    paths: ColabDevPaths,
    private readonly proxy: () => ColabProxy,
    private readonly cells: CellManager,
    private readonly execute: ExecutionManager,
    private readonly runtime: RuntimeManager,
  ) {
    this.store = new WorkflowStore(paths);
  }

  async list(filter: WorkflowSourceFilter = 'all'): Promise<WorkflowInfo[]> {
    try {
      if (await this.hasMcpWorkflowTools()) {
        const mcpList = await this.listViaMcp();
        if (filter === 'uploaded' || filter === 'all') {
          return mcpList;
        }
      }

      const registry = await this.store.loadRegistry();
      const local = await this.store.listLocal();
      const byId = new Map<string, WorkflowInfo>();

      for (const def of local) {
        byId.set(def.id, {
          id: def.id,
          name: def.name,
          description: def.description,
          source: 'local',
          loaded: Boolean(registry[def.id]),
          stepCount: def.steps.length,
          path: `${this.store.workflowsDir}/${def.id}.json`,
        });
      }

      for (const [id, loaded] of Object.entries(registry)) {
        if (byId.has(id)) {
          const info = byId.get(id)!;
          info.loaded = true;
          info.source = loaded.source;
          continue;
        }

        let definition: WorkflowDefinition | null = null;
        if (loaded.localPath) {
          try {
            definition = await this.store.readDefinition(loaded.localPath);
          } catch {
            definition = null;
          }
        }

        byId.set(id, {
          id,
          name: definition?.name ?? id,
          description: definition?.description,
          source: 'uploaded',
          loaded: true,
          stepCount: definition?.steps.length ?? loaded.cellIds.length,
          path: loaded.localPath,
        });
      }

      const all = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (filter === 'local') return all.filter((w) => w.source === 'local');
      if (filter === 'uploaded') return all.filter((w) => w.loaded && w.source === 'uploaded');
      return all;
    } catch (err) {
      throw wrapError(err, 'Failed to list workflows');
    }
  }

  async get(idOrPath: string): Promise<WorkflowDefinition> {
    try {
      const { definition } = await this.store.resolveDefinition(idOrPath);
      return definition;
    } catch (err) {
      throw new WorkflowNotFoundError(idOrPath, err);
    }
  }

  async save(definition: WorkflowDefinition): Promise<string> {
    try {
      return await this.store.saveDefinition(definition);
    } catch (err) {
      throw wrapError(err, 'Failed to save workflow');
    }
  }

  async upload(filePath: string, options: { load?: boolean } = {}): Promise<WorkflowInfo> {
    try {
      const { definition, path } = await this.store.resolveDefinition(filePath);
      await this.store.saveDefinition(definition);

      if (options.load ?? true) {
        await this.load(definition.id);
      }

      const listed = await this.list('all');
      const info = listed.find((w) => w.id === definition.id);
      if (!info) {
        return {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          source: 'local',
          loaded: options.load ?? true,
          stepCount: definition.steps.length,
          path,
        };
      }
      return info;
    } catch (err) {
      throw wrapError(err, 'Failed to upload workflow');
    }
  }

  async load(idOrPath: string, options: { gpu?: RuntimeType } = {}): Promise<LoadedWorkflow> {
    try {
      if (await this.hasMcpWorkflowTools()) {
        const result = await this.proxy().callTool(TOOL_LOAD_WORKFLOW, {
          workflowId: idOrPath,
          path: idOrPath,
        });
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        const loaded: LoadedWorkflow = {
          id: String(structured?.workflowId ?? structured?.id ?? idOrPath),
          source: 'uploaded',
          localPath: idOrPath,
          loadedAt: new Date().toISOString(),
          cellIds: (structured?.cellIds as string[] | undefined) ?? [],
        };
        await this.store.setLoaded(loaded);
        return loaded;
      }

      const { definition, path } = await this.store.resolveDefinition(idOrPath);
      const existing = await this.store.getLoaded(definition.id);
      if (existing) {
        throw new WorkflowAlreadyLoadedError(definition.id);
      }
      if (options.gpu ?? definition.gpu) {
        await this.runtime.select(options.gpu ?? definition.gpu!);
      }

      const cellIds: string[] = [];
      for (const step of definition.steps) {
        const cell =
          step.type === 'markdown'
            ? await this.cells.createMarkdown(step.source)
            : await this.cells.createCode(step.source);
        cellIds.push(cell.cellId);
      }

      const loaded: LoadedWorkflow = {
        id: definition.id,
        source: path.startsWith(this.store.workflowsDir) ? 'local' : 'uploaded',
        localPath: path,
        loadedAt: new Date().toISOString(),
        cellIds,
      };
      await this.store.setLoaded(loaded);
      return loaded;
    } catch (err) {
      if (err instanceof WorkflowAlreadyLoadedError) throw err;
      throw wrapError(err, `Failed to load workflow: ${idOrPath}`);
    }
  }

  async unload(id: string): Promise<void> {
    try {
      if (await this.hasMcpWorkflowTools()) {
        await this.proxy().callTool(TOOL_UNLOAD_WORKFLOW, { workflowId: id });
        await this.store.removeLoaded(id);
        return;
      }

      const loaded = await this.store.getLoaded(id);
      if (!loaded) {
        throw new WorkflowNotLoadedError(id);
      }

      for (const cellId of loaded.cellIds) {
        await this.cells.remove(cellId).catch(() => {});
      }
      await this.store.removeLoaded(id);
    } catch (err) {
      if (err instanceof WorkflowNotLoadedError) throw err;
      throw wrapError(err, `Failed to unload workflow: ${id}`);
    }
  }

  async run(id: string, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
    const steps: WorkflowStepResult[] = [];
    try {
      if (await this.hasMcpWorkflowTools()) {
        this.runningWorkflowId = id;
        const result = await this.proxy().callTool(
          TOOL_RUN_WORKFLOW,
          { workflowId: id, stream: false },
          300_000,
        );
        this.runningWorkflowId = null;
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        const rawSteps = (structured?.steps as WorkflowStepResult[] | undefined) ?? [];
        return {
          workflowId: id,
          steps: rawSteps,
          success: !(structured?.isError ?? result.isError),
        };
      }

      const definition = await this.prepareWorkflow(id, options);
      this.runningWorkflowId = id;

      for (let i = 0; i < definition.steps.length; i++) {
        const step = definition.steps[i]!;
        if (step.type === 'markdown') {
          steps.push({ stepIndex: i, type: 'markdown', skipped: true });
          continue;
        }
        if (!isCodeStep(step)) {
          steps.push({ stepIndex: i, type: 'code', skipped: true });
          continue;
        }

        const loaded = await this.store.getLoaded(definition.id);
        const cellId = loaded?.cellIds[i];
        const result = cellId
          ? await this.execute.runCell(cellId)
          : await this.execute.runCode(step.source, { cleanup: true });

        steps.push({
          stepIndex: i,
          type: 'code',
          cellId: result.cellId ?? cellId,
          result,
        });
      }

      this.runningWorkflowId = null;
      return { workflowId: definition.id, steps, success: true };
    } catch (err) {
      this.runningWorkflowId = null;
      if (err instanceof WorkflowExecutionError) throw err;
      if (err instanceof WorkflowNotLoadedError) throw err;
      const stepIndex = steps.at(-1)?.stepIndex;
      if (err instanceof ExecutionError) {
        throw new WorkflowExecutionError(err.message, id, stepIndex, steps, err);
      }
      throw new WorkflowExecutionError(
        err instanceof Error ? err.message : 'Workflow execution failed',
        id,
        stepIndex,
        steps,
        err,
      );
    }
  }

  async *runStream(id: string, options: WorkflowRunOptions = {}): AsyncGenerator<WorkflowStreamChunk> {
    try {
      if (await this.hasMcpWorkflowTools()) {
        this.runningWorkflowId = id;
        const result = await this.proxy().callTool(
          TOOL_RUN_WORKFLOW,
          { workflowId: id, stream: true },
          300_000,
        );
        this.runningWorkflowId = null;
        const structured = result.structuredContent as Record<string, unknown> | undefined;
        const chunks = (structured?.chunks as Array<Record<string, unknown>> | undefined) ?? [];
        for (const chunk of chunks) {
          yield {
            workflowId: id,
            stepIndex: Number(chunk.stepIndex ?? 0),
            stepType: (chunk.stepType as 'code' | 'markdown') ?? 'code',
            type: (chunk.type as OutputChunk['type']) ?? 'stdout',
            text: String(chunk.text ?? ''),
            timestamp: Number(chunk.timestamp ?? Date.now()),
          };
        }
        if (structured?.isError ?? result.isError) {
          throw new WorkflowExecutionError(
            String(structured?.error ?? 'Workflow stream failed'),
            id,
          );
        }
        return;
      }

      const definition = await this.prepareWorkflow(id, options);
      this.runningWorkflowId = id;

      for (let i = 0; i < definition.steps.length; i++) {
        const step = definition.steps[i]!;
        if (!isCodeStep(step)) continue;

        const loaded = await this.store.getLoaded(definition.id);
        const cellId = loaded?.cellIds[i];
        const ref = cellId ?? (await this.cells.createCode(step.source)).cellId;

        for await (const chunk of this.execute.streamCell(ref)) {
          yield {
            ...chunk,
            workflowId: definition.id,
            stepIndex: i,
            stepType: 'code',
          };
        }

        if (!cellId) {
          await this.cells.remove(ref).catch(() => {});
        }
      }

      this.runningWorkflowId = null;
    } catch (err) {
      this.runningWorkflowId = null;
      throw wrapError(err, `Failed to stream workflow: ${id}`);
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.runningWorkflowId && (await this.hasMcpWorkflowTools())) {
        await this.proxy().callTool(TOOL_STOP_WORKFLOW, {
          workflowId: this.runningWorkflowId,
        });
      }
      await this.execute.interrupt();
      this.runningWorkflowId = null;
    } catch (err) {
      throw wrapError(err, 'Failed to stop workflow');
    }
  }

  isRunning(): boolean {
    return this.runningWorkflowId !== null;
  }

  runningId(): string | null {
    return this.runningWorkflowId;
  }

  private async prepareWorkflow(id: string, options: WorkflowRunOptions): Promise<WorkflowDefinition> {
    const autoLoad = options.autoLoad ?? true;
    let loaded = await this.store.getLoaded(id);

    if (!loaded && autoLoad) {
      loaded = await this.load(id, { gpu: options.gpu });
    }
    if (!loaded) {
      throw new WorkflowNotLoadedError(id);
    }

    const { definition } = await this.store.resolveDefinition(loaded.localPath ?? id);
    if (options.gpu ?? definition.gpu) {
      await this.runtime.select(options.gpu ?? definition.gpu!);
    }
    return definition;
  }

  private async hasMcpWorkflowTools(): Promise<boolean> {
    if (this.mcpWorkflowToolsAvailable !== null) {
      return this.mcpWorkflowToolsAvailable;
    }
    try {
      const tools = await this.proxy().listTools();
      const names = new Set(tools.map((t) => t.name));
      this.mcpWorkflowToolsAvailable = WORKFLOW_MCP_TOOLS.every((name) => names.has(name));
    } catch {
      this.mcpWorkflowToolsAvailable = false;
    }
    return this.mcpWorkflowToolsAvailable;
  }

  private async listViaMcp(): Promise<WorkflowInfo[]> {
    const result = await this.proxy().callTool(TOOL_LIST_WORKFLOWS, {});
    const registry = await this.store.loadRegistry();
    return parseWorkflowListResult(result).map((w) => ({
      id: w.id,
      name: w.name ?? w.id,
      source: w.source === 'local' ? 'local' : 'uploaded',
      loaded: Boolean(registry[w.id]) || w.source === 'uploaded',
      stepCount: 0,
    }));
  }
}
