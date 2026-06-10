import { describe, expect, it } from 'vitest';

import {
  isCodeStep,
  normalizeWorkflowDefinition,
  parseWorkflowListResult,
  workflowIdFromPath,
} from '../src/workflows/workflowUtils.js';

describe('workflowUtils', () => {
  it('derives workflow id from path', () => {
    expect(workflowIdFromPath('/tmp/hello-world.workflow.json')).toBe('hello-world');
    expect(workflowIdFromPath('demo.json')).toBe('demo');
  });

  it('detects runnable code steps', () => {
    expect(isCodeStep({ type: 'code', source: 'print(1)' })).toBe(true);
    expect(isCodeStep({ type: 'code', source: '  ', skipIfEmpty: true })).toBe(false);
    expect(isCodeStep({ type: 'markdown', source: '# x' })).toBe(false);
  });

  it('normalizes workflow definitions with fallback id', () => {
    const normalized = normalizeWorkflowDefinition({ steps: [{ type: 'code', source: 'x' }] }, 'fallback');
    expect(normalized.id).toBe('fallback');
    expect(normalized.name).toBe('fallback');
  });

  it('parses MCP workflow list payloads', () => {
    const parsed = parseWorkflowListResult({
      structuredContent: {
        workflows: [
          { id: 'a', name: 'A', source: 'local' },
          { workflowId: 'b', name: 'B', source: 'uploaded' },
        ],
      },
    });
    expect(parsed).toEqual([
      { id: 'a', name: 'A', source: 'local' },
      { id: 'b', name: 'B', source: 'uploaded' },
    ]);
  });

  it('parses top-level workflows array and ignores empty ids', () => {
    const parsed = parseWorkflowListResult({
      workflows: [{ id: '' }, { id: 'valid', name: 'Valid' }],
    });
    expect(parsed).toEqual([{ id: 'valid', name: 'Valid', source: undefined }]);
  });
});
