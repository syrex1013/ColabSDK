/**
 * End-to-end login + Colab SDK test.
 *
 * Set credentials via environment variables (never commit passwords):
 *   COLAB_GOOGLE_EMAIL=you@example.com
 *   COLAB_GOOGLE_PASSWORD=your-password
 *
 * Run:
 *   bun run test:login
 */

import { rm } from 'node:fs/promises';

import { ColabClient } from '../src/index.js';

const MAX_ATTEMPTS = 3;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Export it in your shell before running this script.`);
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(attempt: number): Promise<void> {
  const email = requireEnv('COLAB_GOOGLE_EMAIL');
  const password = requireEnv('COLAB_GOOGLE_PASSWORD');
  const forceLogin = process.env.COLAB_FORCE_LOGIN === '1' && attempt === 1;

  const client = new ColabClient();
  console.log(`\n=== Attempt ${attempt}/${MAX_ATTEMPTS} ===`);
  console.log(`Data dir: ${client.paths.root}`);

  if (process.env.COLAB_RESET_SESSION === '1' && attempt === 1) {
    console.log('Resetting browser profile...');
    await rm(client.paths.browserProfile, { recursive: true, force: true });
  }

  try {
    const loggedIn = !forceLogin && (await client.auth.isLoggedIn());
    console.log(
      loggedIn ? 'Existing session found.' : 'Logging in with credentials (headed browser)...',
    );

    if (!loggedIn) {
      await client.auth.login({
        email,
        password,
        headless: false,
        exportState: true,
        twoFactorWaitMs: 300_000,
        allowHeadedFallback: true,
      });
      console.log('Login succeeded.');
    }

    const headless = process.env.COLAB_HEADLESS !== '0';
    console.log(`Connecting to Colab (${headless ? 'headless' : 'headed'})...`);
    const info = await client.connect({ headless, email, password });
    console.log('Connected:', info);

    console.log('Listing cells (smoke test)...');
    const beforeCells = await client.cells.list();
    console.log(`Cells before run: ${beforeCells.length}`);

    console.log('Running test code...');
    const result = await client.execute.runCode(`
import sys
print("ColabSDK login test OK")
print("Python:", sys.version.split()[0])
`);
    console.log('stdout:', result.stdout.trim());
    if (result.stderr) console.log('stderr:', result.stderr.trim());

    const cells = await client.cells.list();
    console.log(`Notebook cells: ${cells.length}`);

    const health = await client.runtime.health();
    console.log('Runtime health:', health);

    console.log('\nAll tests passed.');
  } finally {
    await client.disconnect();
  }
}

async function main(): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runOnce(attempt);
      return;
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
      if (attempt < MAX_ATTEMPTS) {
        console.log('Retrying in 5s...');
        await sleep(5000);
      }
    }
  }

  console.error('\nAll attempts failed.');
  throw lastError;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
