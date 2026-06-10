/**
 * Stream cell output while execution runs.
 *
 *   bun run example:stream
 */

import { createAuthenticatedClient, connectHeadless } from './_helpers.js';

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();

  try {
    await connectHeadless(client);

    const cell = await client.cells.createCode(`
import time
for i in range(3):
    print(f"step {i}")
    time.sleep(0.5)
print("done")
`);

    console.log('Streaming output...');
    for await (const chunk of client.execute.streamCell(cell.cellId)) {
      console.log(`[${chunk.type}] ${chunk.text.trim()}`);
    }

    await client.cells.remove(cell.cellId);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
