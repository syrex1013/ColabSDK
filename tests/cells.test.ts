import { describe, expect, it } from 'vitest';

import {
  extractCellId,
  extractCells,
  hasErrorOutput,
  joinSource,
  normalizeCell,
  outputsToText,
  parseCellResult,
} from '../src/cells/cellUtils.js';

describe('cellUtils', () => {
  it('normalizes raw cells', () => {
    const cell = normalizeCell(
      {
        cellId: 'abc',
        cellIndex: 2,
        cellType: 'code',
        source: ['print("hi")\n'],
      },
      0,
    );

    expect(cell.cellId).toBe('abc');
    expect(cell.cellIndex).toBe(2);
    expect(cell.source).toBe('print("hi")\n');
  });

  it('extracts cells from structured content', () => {
    const cells = extractCells({
      structuredContent: {
        cells: [
          { cellId: '1', cellType: 'text', source: '# Title' },
          { cellId: '2', cellType: 'code', source: '1+1' },
        ],
      },
    });

    expect(cells).toHaveLength(2);
    expect(cells[0]?.cellType).toBe('text');
    expect(cells[1]?.cellType).toBe('code');
  });

  it('extracts new cell id from add_code_cell response', () => {
    expect(
      extractCellId({
        structuredContent: { newCellId: 'HQf77LgniUbT' },
        content: [{ type: 'text', text: '{"newCellId":"HQf77LgniUbT"}' }],
      }),
    ).toBe('HQf77LgniUbT');
  });

  it('parses execution output', () => {
    const parsed = parseCellResult({
      structuredContent: {
        outputs: [
          {
            output_type: 'stream',
            name: 'stdout',
            text: ['hello\n', 'world\n'],
          },
        ],
        isError: false,
        executionCount: 1,
      },
    });

    expect(parsed.stdout).toBe('hello\nworld\n');
    expect(parsed.isError).toBe(false);
    expect(parsed.executionCount).toBe(1);
  });

  it('joins array and string sources', () => {
    expect(joinSource(['a', 'b'])).toBe('ab');
    expect(joinSource('solo')).toBe('solo');
    expect(joinSource(undefined)).toBe('');
  });

  it('normalizes markdown cells as text', () => {
    const cell = normalizeCell({ cell_type: 'markdown', source: '# Title' }, 0);
    expect(cell.cellType).toBe('text');
    expect(cell.source).toBe('# Title');
  });

  it('parses stderr streams and tracebacks', () => {
    const parsed = parseCellResult({
      structuredContent: {
        outputs: [
          { output_type: 'stream', name: 'stderr', text: ['warn\n'] },
          { output_type: 'error', traceback: ['Traceback\n', 'Error\n'] },
        ],
        isError: true,
      },
    });
    expect(parsed.stderr).toContain('warn');
    expect(parsed.stderr).toContain('Traceback');
    expect(parsed.isError).toBe(true);
  });

  it('parses legacy content payloads', () => {
    const parsed = parseCellResult({
      content: [
        { type: 'stderr', text: 'err' },
        { type: 'text', text: 'out' },
        { type: 'text', text: '{"ignored":true}' },
      ],
    });
    expect(parsed.stderr).toBe('err');
    expect(parsed.stdout).toBe('out');
  });

  it('extracts cell id from top-level and json content', () => {
    expect(extractCellId({ cellId: 'direct' })).toBe('direct');
    expect(extractCellId({ content: [{ text: '{"cellId":"from-json"}' }] })).toBe('from-json');
  });

  it('outputsToText handles stream outputs', () => {
    expect(outputsToText([{ output_type: 'stream', text: ['hello\n', 'world\n'] }])).toBe('hello\nworld\n');
  });

  it('outputsToText handles execute_result and display_data', () => {
    expect(outputsToText([{ output_type: 'execute_result', data: { 'text/plain': '42' } }])).toBe('42');
    expect(outputsToText([{ output_type: 'display_data', data: { 'text/plain': ['fig'] } }])).toBe('fig');
  });

  it('outputsToText handles error outputs with traceback', () => {
    const text = outputsToText([
      { output_type: 'error', ename: 'ValueError', evalue: 'bad input', traceback: ['line1', 'line2'] },
    ]);
    expect(text).toContain('ValueError');
    expect(text).toContain('bad input');
    expect(text).toContain('line1');
  });

  it('outputsToText returns empty string for non-arrays', () => {
    expect(outputsToText(null)).toBe('');
    expect(outputsToText(undefined)).toBe('');
    expect(outputsToText([])).toBe('');
  });

  it('hasErrorOutput detects error type outputs', () => {
    expect(hasErrorOutput([])).toBe(false);
    expect(hasErrorOutput([{ output_type: 'stream', text: 'ok' }])).toBe(false);
    expect(hasErrorOutput([{ output_type: 'error', ename: 'E', evalue: 'v' }])).toBe(true);
    expect(hasErrorOutput(null)).toBe(false);
  });
});
