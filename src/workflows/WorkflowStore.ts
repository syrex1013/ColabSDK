import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { ColabSDKError, wrapError } from '../errors/index.js';
import type { ColabDevPaths } from '../storage/ColabDevPaths.js';
import {
  loadedWorkflowSchema,
  workflowDefinitionSchema,
  workflowRegistrySchema,
  type LoadedWorkflow,
  type WorkflowDefinition,
  type WorkflowRegistry,
} from './workflowSchema.js';
import { normalizeWorkflowDefinition, workflowIdFromPath } from './workflowUtils.js';

export class WorkflowStore {
  readonly workflowsDir: string;
  readonly registryFile: string;

  constructor(paths: ColabDevPaths) {
    this.workflowsDir = join(paths.root, 'workflows');
    this.registryFile = join(this.workflowsDir, 'registry.json');
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.workflowsDir, { recursive: true });
  }

  async listLocal(): Promise<WorkflowDefinition[]> {
    await this.ensureDirs();
    const entries = await readdir(this.workflowsDir, { withFileTypes: true });
    const workflows: WorkflowDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (entry.name === 'registry.json') continue;
      try {
        workflows.push(await this.readDefinition(join(this.workflowsDir, entry.name)));
      } catch {
        // skip invalid workflow files
      }
    }

    return workflows.sort((a, b) => a.id.localeCompare(b.id));
  }

  async readDefinition(filePath: string): Promise<WorkflowDefinition> {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeWorkflowDefinition(parsed, workflowIdFromPath(filePath));
    const result = workflowDefinitionSchema.safeParse(normalized);
    if (!result.success) {
      throw new ColabSDKError(
        `Invalid workflow definition in ${filePath}: ${result.error.message}`,
        'UNKNOWN',
      );
    }
    return result.data;
  }

  async saveDefinition(definition: WorkflowDefinition): Promise<string> {
    const parsed = workflowDefinitionSchema.parse(definition);
    await this.ensureDirs();
    const filePath = join(this.workflowsDir, `${parsed.id}.json`);
    await writeFile(filePath, JSON.stringify(parsed, null, 2));
    return filePath;
  }

  async resolveDefinition(idOrPath: string): Promise<{ definition: WorkflowDefinition; path: string }> {
    if (isAbsolute(idOrPath) || idOrPath.includes('/') || idOrPath.endsWith('.json')) {
      const definition = await this.readDefinition(idOrPath);
      return { definition, path: idOrPath };
    }

    const localPath = join(this.workflowsDir, `${idOrPath}.json`);
    try {
      const definition = await this.readDefinition(localPath);
      return { definition, path: localPath };
    } catch (err) {
      throw wrapError(err, `Workflow not found: ${idOrPath}`);
    }
  }

  async loadRegistry(): Promise<WorkflowRegistry> {
    try {
      const raw = await readFile(this.registryFile, 'utf-8');
      const parsed = workflowRegistrySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async saveRegistry(registry: WorkflowRegistry): Promise<void> {
    await this.ensureDirs();
    await writeFile(this.registryFile, JSON.stringify(registry, null, 2));
  }

  async getLoaded(id: string): Promise<LoadedWorkflow | null> {
    const registry = await this.loadRegistry();
    const entry = registry[id];
    if (!entry) return null;
    const parsed = loadedWorkflowSchema.safeParse(entry);
    return parsed.success ? parsed.data : null;
  }

  async setLoaded(entry: LoadedWorkflow): Promise<void> {
    const registry = await this.loadRegistry();
    registry[entry.id] = loadedWorkflowSchema.parse(entry);
    await this.saveRegistry(registry);
  }

  async removeLoaded(id: string): Promise<LoadedWorkflow | null> {
    const registry = await this.loadRegistry();
    const existing = registry[id] ?? null;
    delete registry[id];
    await this.saveRegistry(registry);
    return existing;
  }

  async deleteLocal(id: string): Promise<void> {
    const filePath = join(this.workflowsDir, `${id}.json`);
    await unlink(filePath).catch(() => {});
  }
}
