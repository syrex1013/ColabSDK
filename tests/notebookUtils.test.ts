import { describe, expect, it } from 'vitest';

import { stripOutputs } from '../src/cells/notebookUtils.js';

describe('stripOutputs', () => {
  it('strips outputs and execution_count from all cells', () => {
    const nb = JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: 'print(1)',
          outputs: [{ output_type: 'stream', name: 'stdout', text: '1\n' }],
          execution_count: 5,
        },
        { cell_type: 'markdown', source: '# Title', outputs: [] },
      ],
    });
    const stripped = JSON.parse(stripOutputs(nb)) as {
      cells: Array<{ outputs: unknown[]; execution_count: unknown }>;
    };
    expect(stripped.cells[0]?.outputs).toEqual([]);
    expect(stripped.cells[0]?.execution_count).toBeNull();
    expect(stripped.cells[1]?.outputs).toEqual([]);
    expect(stripped.cells[1]?.execution_count).toBeNull();
  });

  it('handles an empty cells array', () => {
    const nb = JSON.stringify({ cells: [] });
    const stripped = JSON.parse(stripOutputs(nb)) as { cells: unknown[] };
    expect(stripped.cells).toEqual([]);
  });

  it('preserves other notebook metadata', () => {
    const nb = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' } }, cells: [] });
    const stripped = JSON.parse(stripOutputs(nb)) as { nbformat: number; nbformat_minor: number };
    expect(stripped.nbformat).toBe(4);
    expect(stripped.nbformat_minor).toBe(5);
  });
});
