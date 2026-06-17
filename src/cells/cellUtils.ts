import type { Cell, RawCell } from '../types/index.js';

export interface JupyterOutput {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  traceback?: string | string[];
  ename?: string;
  evalue?: string;
}

export function joinSource(source: string | string[] | undefined): string {
  if (!source) return '';
  return Array.isArray(source) ? source.join('') : source;
}

export function normalizeCell(raw: RawCell, index: number): Cell {
  const cellTypeRaw = raw.cellType ?? raw.cell_type ?? 'code';
  const cellType = cellTypeRaw === 'markdown' || cellTypeRaw === 'text' ? 'text' : 'code';

  return {
    cellId: raw.cellId ?? raw.id ?? `cell-${index}`,
    cellIndex: raw.cellIndex ?? raw.index ?? index,
    cellType,
    source: joinSource(raw.source) || raw.content || '',
    outputs: raw.outputs,
  };
}

export function extractCellId(result: Record<string, unknown>): string | undefined {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const fromStructured =
    (typeof structured?.cellId === 'string' && structured.cellId) ||
    (typeof structured?.newCellId === 'string' && structured.newCellId);
  if (fromStructured) return fromStructured;

  if (typeof result.cellId === 'string') return result.cellId;
  if (typeof result.newCellId === 'string') return result.newCellId;

  const content = result.content as Array<{ text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { cellId?: string; newCellId?: string };
      return parsed.newCellId ?? parsed.cellId;
    } catch {
      // ignore non-json tool text payloads
    }
  }

  return undefined;
}

export function extractCells(result: Record<string, unknown>): Cell[] {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const rawCells =
    (structured?.cells as RawCell[] | undefined) ??
    (result.cells as RawCell[] | undefined) ??
    [];

  return rawCells.map((c, i) => normalizeCell(c, i));
}

export function outputsToText(outputs: unknown): string {
  if (!Array.isArray(outputs)) return '';
  return (outputs as JupyterOutput[])
    .map((o) => {
      if (!o || typeof o !== 'object') return '';
      const joinText = (v: string | string[] | undefined): string =>
        Array.isArray(v) ? v.join('') : (v ?? '');
      if (o.output_type === 'stream') return joinText(o.text);
      if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
        return joinText((o as JupyterOutput & { data?: Record<string, string | string[]> }).data?.['text/plain']);
      }
      if (o.output_type === 'error') {
        const tb = Array.isArray(o.traceback) ? o.traceback.join('\n') : (o.traceback ?? '');
        return `${o.ename ?? 'Error'}: ${o.evalue ?? ''}\n${tb}`;
      }
      return joinText(o.text);
    })
    .join('');
}

export function hasErrorOutput(outputs: unknown): boolean {
  if (!Array.isArray(outputs)) return false;
  return (outputs as JupyterOutput[]).some((o) => o?.output_type === 'error');
}

export function parseCellResult(result: Record<string, unknown>): {
  stdout: string;
  stderr: string;
  outputs: unknown[];
  isError: boolean;
  executionCount?: number;
} {
  const parsed = result as {
    structuredContent?: {
      outputs?: Array<{ text?: string | string[] }>;
      isError?: boolean;
      executionCount?: number;
    };
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };

  const structured = parsed.structuredContent;
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const outputs: unknown[] = structured?.outputs ?? [];

  if (structured?.outputs?.length) {
    for (const out of structured.outputs) {
      const stream = out as {
        output_type?: string;
        name?: string;
        text?: string | string[];
        traceback?: string | string[];
      };
      const texts = Array.isArray(stream.text) ? stream.text : stream.text ? [stream.text] : [];
      const isErr =
        stream.output_type === 'error' ||
        stream.name === 'stderr' ||
        Boolean(stream.traceback);
      const target = isErr ? stderrParts : stdoutParts;
      for (const t of texts) target.push(t);
      if (stream.traceback) {
        const trace = Array.isArray(stream.traceback) ? stream.traceback : [stream.traceback];
        stderrParts.push(...trace);
      }
    }
  } else if (parsed.content) {
    for (const item of parsed.content) {
      const text = item.text ?? '';
      if (item.type === 'stderr') stderrParts.push(text);
      else if (!text.startsWith('{')) stdoutParts.push(text);
    }
  }

  return {
    stdout: stdoutParts.join(''),
    stderr: stderrParts.join(''),
    outputs,
    isError: structured?.isError ?? parsed.isError ?? false,
    executionCount: structured?.executionCount,
  };
}
