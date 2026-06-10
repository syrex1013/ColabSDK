/**
 * Demonstrates typed SDK errors.
 *
 *   bun run example:errors
 */

import {
  CellNotFoundError,
  ColabClient,
  ColabSDKError,
  LoginRequiredError,
} from '../src/index.js';

async function main(): Promise<void> {
  const client = new ColabClient();

  // Not connected
  try {
    await client.cells.list();
  } catch (err) {
    printError('cells.list() before connect', err);
  }

  // Cell not found (needs connection — skip if not logged in)
  if (await client.auth.isLoggedIn()) {
    try {
      await client.connect({ headless: true });
      await client.cells.resolve('nonexistent-cell-id');
    } catch (err) {
      printError('resolve missing cell', err);
    } finally {
      await client.disconnect();
    }
  } else {
    console.log('\n[skip] cell not found demo — log in first with example:login');
    printError('simulated CellNotFoundError', new CellNotFoundError('demo'));
  }

  printError('simulated LoginRequiredError', new LoginRequiredError());
}

function printError(label: string, err: unknown): void {
  console.log(`\n[${label}]`);
  if (err instanceof ColabSDKError) {
    console.log('  name:', err.name);
    console.log('  code:', err.code);
    console.log('  message:', err.message);
    console.log('  json:', JSON.stringify(err.toJSON()));
  } else if (err instanceof Error) {
    console.log('  message:', err.message);
  } else {
    console.log('  value:', err);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
