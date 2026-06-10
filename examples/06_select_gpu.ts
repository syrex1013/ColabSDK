/**
 * Select a GPU runtime and check health.
 *
 *   bun run example:gpu
 *   bun run example:gpu -- t4
 *
 * Note: GPU availability depends on your Colab plan and quotas.
 */

import { createAuthenticatedClient, connectHeadless } from './_helpers.js';
import type { RuntimeType } from '../src/index.js';

const GPU = (process.argv[2] ?? 't4') as RuntimeType;

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();

  try {
    console.log(`Connecting with GPU: ${GPU}`);
    const info = await client.connect({ headless: process.env.COLAB_HEADLESS !== '0', gpu: GPU });
    console.log('Connected:', info);

    const health = await client.runtime.health();
    console.log('Runtime health:', health);

    const gpuCheck = await client.execute.runCode(
      `import json, os
print(json.dumps({"nvidia": os.path.exists("/dev/nvidia0")}))`,
      { cleanup: true },
    );
    console.log('GPU probe:', gpuCheck.stdout.trim());
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
