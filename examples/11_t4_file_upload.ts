/**
 * Select a T4 runtime, upload a local test file, and verify it in Colab.
 *
 *   bun run example:t4-upload
 *
 * Note: GPU availability depends on your Colab plan and quotas.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ColabClient } from '../src/index.js';

async function main(): Promise<void> {
  const client = new ColabClient();
  const headless = process.env.COLAB_HEADLESS !== '0';
  const email = process.env.COLAB_GOOGLE_EMAIL?.trim();
  const password = process.env.COLAB_GOOGLE_PASSWORD?.trim();

  const samplePath = join(fileURLToPath(new URL('.', import.meta.url)), 't4-upload-sample.txt');
  const sampleText = `colab-sdk T4 upload demo ${new Date().toISOString()}\n`;
  await writeFile(samplePath, sampleText);

  try {
    const notebookUrl = await client.createNotebook();
    if (email && password) {
      console.log('Connecting with credentials...');
    } else {
      console.log('Connecting with saved session...');
    }
    await client.connect({
      headless: process.env.COLAB_HEADLESS !== '0',
      notebookUrl,
      email: email ?? undefined,
      password: password ?? undefined,
    });

    const sessions = await client.runtime.sessions();
    console.log('Active sessions:', sessions);

    const killed = await client.runtime.killOtherSessions();
    console.log(`Terminated ${killed} other session(s)`);

    console.log('Switching to T4 runtime...');
    await client.runtime.select('t4');

    const health = await client.runtime.health();
    console.log('Runtime health:', health);

    const uploadCell = await client.cells.createCode(
      'from google.colab import files\nuploaded = files.upload()\nprint("uploaded:", list(uploaded.keys()))',
    );

    console.log('Uploading test file...');
    const upload = await client.files.upload(uploadCell.cellId, samplePath, {
      onProgress(event) {
        const pct = event.percent !== undefined ? ` ${event.percent}%` : '';
        const method = event.method ? ` (${event.method})` : '';
        console.log(`[${event.phase}]${pct}${method} ${event.message ?? ''}`.trim());
      },
    });
    console.log('Upload result:', upload);

    const verifyUpload = await client.execute.runCode(
      `from pathlib import Path
path = Path('/content/t4-upload-sample.txt')
print('exists:', path.exists())
print('content:', path.read_text().strip())`,
      { cleanup: true },
    );
    console.log('Upload verify:', verifyUpload.stdout.trim());

    const gpuCheck = await client.execute.runCode(
      `from pathlib import Path
try:
    import torch
    print('cuda:', torch.cuda.is_available())
except Exception as exc:
    print('cuda check failed:', type(exc).__name__)`,
      { cleanup: true },
    );
    console.log('GPU verify:', gpuCheck.stdout.trim());
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(err.message);
    const cause = (err as any).cause;
    if (cause instanceof Error) console.error('Caused by:', cause.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
