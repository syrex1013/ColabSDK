import { joinSource } from '../cells/cellUtils.js';
import type { Cell } from '../types/index.js';

const UPLOAD_SOURCE_PATTERNS = [
  /files\.upload\s*\(/,
  /google\.colab\.files/,
  /FileUpload\s*\(/,
  /widgets\.FileUpload/,
  /ipywidgets\.FileUpload/,
] as const;

export interface UploadCellInfo {
  cellId: string;
  cellIndex: number;
  reason: 'source' | 'output' | 'both';
}

export interface CellUploadDomState {
  hasFileInput: boolean;
  fileInputCount: number;
  progressPercent?: number;
  statusText?: string;
  uploadedFileNames: string[];
  complete: boolean;
}

export function cellSourceHasFileUpload(source: string): boolean {
  return UPLOAD_SOURCE_PATTERNS.some((pattern) => pattern.test(source));
}

export function cellOutputsHaveFileUpload(outputs: unknown[] | undefined): boolean {
  if (!outputs?.length) return false;
  const json = JSON.stringify(outputs).toLowerCase();
  return (
    json.includes('fileupload') ||
    json.includes('application/vnd.jupyter.widget-view') ||
    json.includes('choose files') ||
    json.includes('input[type=file]')
  );
}

export function cellHasFileUpload(cell: Cell): boolean {
  const source = joinSource(cell.source);
  const fromSource = cellSourceHasFileUpload(source);
  const fromOutput = cellOutputsHaveFileUpload(cell.outputs);
  if (fromSource && fromOutput) return true;
  return fromSource || fromOutput;
}

export function describeUploadCell(cell: Cell): UploadCellInfo | null {
  const source = joinSource(cell.source);
  const fromSource = cellSourceHasFileUpload(source);
  const fromOutput = cellOutputsHaveFileUpload(cell.outputs);
  if (!fromSource && !fromOutput) return null;

  return {
    cellId: cell.cellId,
    cellIndex: cell.cellIndex,
    reason: fromSource && fromOutput ? 'both' : fromSource ? 'source' : 'output',
  };
}

export function parseUploadProgressText(text: string): {
  progressPercent?: number;
  statusText?: string;
  uploadedFileNames: string[];
} {
  const uploadedFileNames: string[] = [];
  const percentMatch = text.match(/(\d{1,3})\s*%/);
  const progressPercent = percentMatch ? Math.min(100, Number(percentMatch[1])) : undefined;

  const filePattern =
    /[\w.-]+\.(csv|json|txt|zip|tar|gz|png|jpg|jpeg|pdf|parquet|npy|npz|pkl|pt|onnx|h5|feather|xlsx?|docx?)\b/gi;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matches = trimmed.match(filePattern);
    if (matches) {
      uploadedFileNames.push(...matches);
    }
  }

  const statusText = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /upload|transfer|complete|done|saving/i.test(l));

  return { progressPercent, statusText, uploadedFileNames };
}

export function mergeUploadDomState(
  raw: {
    hasFileInput: boolean;
    fileInputCount: number;
    textContent: string;
    progressValue?: number;
    progressMax?: number;
  },
): CellUploadDomState {
  const parsed = parseUploadProgressText(raw.textContent);
  const progressPercent =
    raw.progressMax && raw.progressMax > 0
      ? Math.round((raw.progressValue! / raw.progressMax) * 100)
      : parsed.progressPercent;

  const complete =
    !raw.hasFileInput &&
    (progressPercent === 100 ||
      /uploaded|complete|done|saved/i.test(raw.textContent) ||
      parsed.uploadedFileNames.length > 0);

  return {
    hasFileInput: raw.hasFileInput,
    fileInputCount: raw.fileInputCount,
    progressPercent,
    statusText: parsed.statusText,
    uploadedFileNames: parsed.uploadedFileNames,
    complete,
  };
}
