import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** 192 KiB raw per chunk keeps JSON-RPC payloads reasonable. */
export const RUNTIME_UPLOAD_CHUNK_BYTES = 192 * 1024;

export function buildRuntimeUploadScript(remoteName: string, base64Chunks: string[]): string {
  const chunksLiteral = base64Chunks.map((c) => JSON.stringify(c)).join(',\n    ');
  return `
import base64, os
path = '/content/${remoteName.replace(/'/g, "\\'")}'
os.makedirs('/content', exist_ok=True)
with open(path, 'wb') as out:
    for chunk in [
    ${chunksLiteral}
    ]:
        out.write(base64.b64decode(chunk))
print(path)
`.trim();
}

export async function readFileAsBase64Chunks(
  filePath: string,
  chunkBytes = RUNTIME_UPLOAD_CHUNK_BYTES,
): Promise<{ remoteName: string; chunks: string[]; size: number }> {
  const data = await readFile(filePath);
  const remoteName = basename(filePath);
  const chunks: string[] = [];

  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    chunks.push(data.subarray(offset, offset + chunkBytes).toString('base64'));
  }

  if (chunks.length === 0) {
    chunks.push('');
  }

  return { remoteName, chunks, size: data.length };
}
