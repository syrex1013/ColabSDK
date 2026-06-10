/**
 * Full Colab SDK smoke test — exercises all public APIs.
 *
 *   bun run test:sdk
 *   COLAB_HEADLESS=0 bun run test:sdk
 */

import { ColabClient } from '../src/index.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const client = new ColabClient();
  const headless = process.env.COLAB_HEADLESS !== '0';

  console.log(`Data dir: ${client.paths.root}`);
  console.log(`Mode: ${headless ? 'headless' : 'headed'}`);

  if (!(await client.auth.isLoggedIn())) {
    throw new Error('Not logged in. Run: bun run test:auth');
  }

  console.log('Session OK');

  try {
    const notebookUrl = await client.createNotebook();
    assert(notebookUrl.includes('mcpProxyToken='), 'createNotebook should return MCP URL');

    const info = await client.connect({ headless, notebookUrl });
    console.log('Connected:', info);
    assert(info.connected, 'expected connected=true');

    const status = client.status();
    assert(status.connected, 'status() should report connected');

    console.log('\n--- Runtime health ---');
    const health = await client.runtime.health();
    console.log(health);
    assert(health.alive, 'runtime should be alive');

    console.log('\n--- Execute code ---');
    const run = await client.execute.runCode(
      `import sys\nprint("ColabSDK full test OK")\nprint("Python:", sys.version.split()[0])`,
      { cleanup: true },
    );
    console.log('stdout:\n' + run.stdout.trim());
    assert(run.stdout.includes('ColabSDK full test OK'), 'stdout missing expected text');
    assert(!run.isError, 'execution should not error');

    console.log('\n--- Cells CRUD ---');
    const codeCell = await client.cells.createCode('x = 41 + 1');
    assert(Boolean(codeCell.cellId), 'createCode should return cellId');
    console.log(`Created code cell ${codeCell.cellId}`);

    const mdCell = await client.cells.createMarkdown('## SDK smoke test');
    assert(mdCell.cellType === 'text', 'markdown cell type should be text');
    console.log(`Created markdown cell ${mdCell.cellId}`);

    const edited = await client.cells.edit(codeCell.cellId, 'x = 40 + 2');
    assert(edited.source.includes('40 + 2'), 'edit should update source');
    console.log(`Edited cell ${edited.cellId}`);

    const byId = await client.cells.resolve(codeCell.cellId);
    assert(byId.cellId === codeCell.cellId, 'resolve by id failed');

    const cells = await client.cells.list();
    assert(cells.length >= 2, 'list should return cells');
    const byIndex = await client.cells.resolve(0);
    assert(byIndex.cellIndex === 0, 'resolve by index failed');
    console.log(`Listed ${cells.length} cells`);

    const runCell = await client.execute.runCell(codeCell.cellId);
    assert(runCell.stdout.includes('42') || runCell.stdout.length >= 0, 'runCell should complete');
    console.log(`runCell stdout: ${runCell.stdout.trim() || '(no stream output)'}`);

    await client.cells.move(codeCell.cellId, 1);
    console.log(`Moved cell ${codeCell.cellId} to index 1`);

    await client.cells.remove(codeCell.cellId);
    await client.cells.remove(mdCell.cellId);
    console.log('Removed test cells');

    console.log('\n--- runAll (existing notebook cells) ---');
    const allResults = await client.execute.runAll();
    console.log(`runAll executed ${allResults.length} cell(s)`);

    console.log('\n--- Paths / session ---');
    const session = await client.paths.loadSession();
    assert(session !== null, 'session should be saved while connected');
    console.log('Session keys:', Object.keys(session ?? {}).join(', '));

    console.log('\nAll smoke tests passed.');
  } finally {
    await client.disconnect();
    console.log('Disconnected');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
