/**
 * Create, edit, list, move, and delete notebook cells.
 *
 *   bun run example:cells
 */

import { createAuthenticatedClient, connectHeadless } from './_helpers.js';

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();

  try {
    await connectHeadless(client);

    const code = await client.cells.createCode('answer = 6 * 7');
    console.log('Created code cell:', code.cellId);

    const md = await client.cells.createMarkdown('## ColabSDK cell demo');
    console.log('Created markdown cell:', md.cellId);

    const updated = await client.cells.edit(code.cellId, 'answer = 40 + 2');
    console.log('Edited source:', client.cells.sourceOf(updated));

    const all = await client.cells.list();
    console.log(`Notebook has ${all.length} cell(s)`);

    const run = await client.execute.runCell(code.cellId);
    console.log('Execution output:', run.stdout.trim() || '(no stdout)');

    await client.cells.move(code.cellId, 1);
    console.log('Moved code cell to index 1');

    await client.cells.remove(code.cellId);
    await client.cells.remove(md.cellId);
    console.log('Cleaned up demo cells');
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
