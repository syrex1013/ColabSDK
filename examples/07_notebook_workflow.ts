/**
 * End-to-end notebook workflow: cells + runAll + status.
 *
 *   bun run example:workflow
 */

import { createAuthenticatedClient } from './_helpers.js';

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();

  try {
    const notebookUrl = await client.createNotebook();
    console.log('Notebook URL ready');

    await client.connect({ headless: process.env.COLAB_HEADLESS !== '0', notebookUrl });

    await client.cells.createMarkdown('# Automated notebook');
    await client.cells.createCode('import math\npi_approx = round(math.pi, 4)');
    await client.cells.createCode('print(f"pi ≈ {pi_approx}")');

    const results = await client.execute.runAll();
    console.log(`runAll finished ${results.length} code cell(s)`);
    for (const r of results) {
      console.log('---');
      console.log(r.stdout.trim() || '(no output)');
    }

    console.log('Connection status:', client.status());
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
