/**
 * Upload local files into a Colab notebook.
 *
 * Uses the browser widget when available; otherwise writes to /content via the runtime.
 *
 *   bun run example:upload
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthenticatedClient } from './_helpers.js';

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();
  const samplePath = join(fileURLToPath(new URL('.', import.meta.url)), 'upload-sample.txt');
  await writeFile(samplePath, 'colab-sdk upload demo\n');

  try {
    const notebookUrl = await client.createNotebook();
    await client.connect({
      headless: process.env.COLAB_HEADLESS !== '0',
      notebookUrl,
    });

    const cell = await client.cells.createCode(
      'from google.colab import files\nuploaded = files.upload()\nprint("names:", list(uploaded.keys()))',
    );

    console.log('Upload cells:', await client.files.findUploadCells());

    console.log('Uploading with progress...');
    let result;
    for await (const event of client.files.watchUpload(cell.cellId, samplePath)) {
      const pct = event.percent !== undefined ? ` ${event.percent}%` : '';
      const method = event.method ? ` (${event.method})` : '';
      console.log(`[${event.phase}]${pct}${method} ${event.message ?? ''}`.trim());
      if (event.phase === 'complete') {
        result = event;
      }
    }

    const verify = await client.execute.runCode(
      `import os\npath = '/content/upload-sample.txt'\nprint('exists:', os.path.exists(path))\nprint(open(path).read())`,
      { cleanup: true },
    );
    console.log('Verify:', verify.stdout.trim());
    console.log('Upload complete.', result?.method ?? 'unknown');
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
