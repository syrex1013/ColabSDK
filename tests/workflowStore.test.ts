import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ColabDevPaths } from '../src/storage/ColabDevPaths.js';
import { WorkflowStore } from '../src/workflows/WorkflowStore.js';

const SAMPLE_WORKFLOW = {
  id: 'demo',
  name: 'Demo',
  steps: [{ type: 'code', source: 'print(1)' }],
};

describe('WorkflowStore', () => {
  let tempDir: string;
  let store: WorkflowStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colab-workflows-'));
    store = new WorkflowStore(new ColabDevPaths(tempDir));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('saves and lists local workflows', async () => {
    await store.saveDefinition(SAMPLE_WORKFLOW);
    const list = await store.listLocal();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('demo');
  });

  it('resolves workflow by id', async () => {
    await store.saveDefinition(SAMPLE_WORKFLOW);
    const { definition } = await store.resolveDefinition('demo');
    expect(definition.name).toBe('Demo');
  });

  it('tracks loaded workflow registry', async () => {
    await store.setLoaded({
      id: 'demo',
      source: 'local',
      loadedAt: new Date().toISOString(),
      cellIds: ['c1'],
    });
    const loaded = await store.getLoaded('demo');
    expect(loaded?.cellIds).toEqual(['c1']);
    await store.removeLoaded('demo');
    expect(await store.getLoaded('demo')).toBeNull();
  });

  it('reads workflow from absolute path', async () => {
    const filePath = join(tempDir, 'custom.workflow.json');
    await writeFile(filePath, JSON.stringify(SAMPLE_WORKFLOW));
    const { definition, path } = await store.resolveDefinition(filePath);
    expect(definition.id).toBe('demo');
    expect(path).toBe(filePath);
  });

  it('rejects invalid workflow definitions', async () => {
    const filePath = join(tempDir, 'bad.json');
    await writeFile(filePath, JSON.stringify({ name: 'no id or steps' }));
    await expect(store.readDefinition(filePath)).rejects.toThrow('Invalid workflow definition');
  });

  it('skips invalid files when listing local workflows', async () => {
    await store.ensureDirs();
    await writeFile(join(store.workflowsDir, 'broken.json'), '{not json');
    await store.saveDefinition(SAMPLE_WORKFLOW);
    const list = await store.listLocal();
    expect(list).toHaveLength(1);
  });

  it('deletes local workflow file', async () => {
    await store.saveDefinition(SAMPLE_WORKFLOW);
    await store.deleteLocal('demo');
    await expect(store.resolveDefinition('demo')).rejects.toThrow();
  });
});
