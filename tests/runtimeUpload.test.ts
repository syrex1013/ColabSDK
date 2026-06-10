import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRuntimeUploadScript,
  readFileAsBase64Chunks,
  RUNTIME_UPLOAD_CHUNK_BYTES,
} from '../src/files/runtimeUpload.js';

describe('runtimeUpload', () => {
  let tempDir: string;

  afterEach(async () => {
    tempDir = '';
  });

  it('builds a Python script that writes decoded chunks', () => {
    const script = buildRuntimeUploadScript('demo.txt', ['aGVsbG8=', 'd29ybGQ=']);
    expect(script).toContain("path = '/content/demo.txt'");
    expect(script).toContain('base64.b64decode');
    expect(script).toContain('"aGVsbG8="');
    expect(script).toContain('"d29ybGQ="');
  });

  it('reads a file into base64 chunks', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colab-runtime-upload-'));
    const filePath = join(tempDir, 'chunk.txt');
    const payload = 'x'.repeat(RUNTIME_UPLOAD_CHUNK_BYTES + 10);
    await writeFile(filePath, payload);

    const { remoteName, chunks, size } = await readFileAsBase64Chunks(filePath);

    expect(remoteName).toBe('chunk.txt');
    expect(size).toBe(payload.length);
    expect(chunks).toHaveLength(2);
  });

  it('uses an empty chunk for zero-byte files', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colab-runtime-upload-'));
    const filePath = join(tempDir, 'empty.txt');
    await writeFile(filePath, '');

    const { chunks, size } = await readFileAsBase64Chunks(filePath);

    expect(size).toBe(0);
    expect(chunks).toEqual(['']);
  });
});
