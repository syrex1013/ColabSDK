import { describe, expect, it } from 'vitest';

import {
  cellHasFileUpload,
  cellOutputsHaveFileUpload,
  cellSourceHasFileUpload,
  describeUploadCell,
  mergeUploadDomState,
  parseUploadProgressText,
} from '../src/files/cellUploadUtils.js';

describe('cellUploadUtils', () => {
  it('detects upload patterns in cell source', () => {
    expect(cellSourceHasFileUpload('from google.colab import files\nuploaded = files.upload()')).toBe(
      true,
    );
    expect(cellSourceHasFileUpload('print(1)')).toBe(false);
  });

  it('detects upload widgets in outputs', () => {
    expect(
      cellOutputsHaveFileUpload([
        { output_type: 'display_data', data: { 'application/vnd.jupyter.widget-view+json': {} } },
      ]),
    ).toBe(true);
    expect(cellOutputsHaveFileUpload([])).toBe(false);
  });

  it('describes upload cells', () => {
    const info = describeUploadCell({
      cellId: 'c1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    });
    expect(info?.reason).toBe('source');
    expect(cellHasFileUpload({
      cellId: 'c1',
      cellIndex: 0,
      cellType: 'code',
      source: 'files.upload()',
    })).toBe(true);
  });

  it('parses progress text', () => {
    const parsed = parseUploadProgressText('Uploading data.csv\n42%\nComplete');
    expect(parsed.progressPercent).toBe(42);
    expect(parsed.uploadedFileNames).toContain('data.csv');
  });

  it('merges DOM upload state', () => {
    const state = mergeUploadDomState({
      hasFileInput: false,
      fileInputCount: 0,
      textContent: 'data.csv uploaded',
      progressValue: 10,
      progressMax: 10,
    });
    expect(state.complete).toBe(true);
    expect(state.progressPercent).toBe(100);
  });

  it('detects choose files text in outputs', () => {
    expect(cellOutputsHaveFileUpload([{ text: 'Choose Files' }])).toBe(true);
  });

  it('marks cells with source and output as both', () => {
    const info = describeUploadCell({
      cellId: 'c2',
      cellIndex: 1,
      cellType: 'code',
      source: 'files.upload()',
      outputs: [{ output_type: 'display_data', data: { 'application/vnd.jupyter.widget-view+json': {} } }],
    });
    expect(info?.reason).toBe('both');
  });

  it('reports in-progress upload state from progress bar', () => {
    const state = mergeUploadDomState({
      hasFileInput: true,
      fileInputCount: 1,
      textContent: 'Uploading',
      progressValue: 3,
      progressMax: 10,
    });
    expect(state.progressPercent).toBe(30);
    expect(state.complete).toBe(false);
  });
});
