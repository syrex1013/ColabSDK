/**
 * Login with email + password from environment variables.
 *
 *   COLAB_GOOGLE_EMAIL=you@example.com \
 *   COLAB_GOOGLE_PASSWORD=your-password \
 *   bun run example:login-creds
 *
 * Optional:
 *   COLAB_HEADLESS=0          # show browser (recommended for 2FA)
 *   COLAB_RESET_SESSION=1     # wipe saved profile first
 */

import { rm } from 'node:fs/promises';

import { ColabClient } from '../src/index.js';
import { requireEnv } from './_helpers.js';

async function main(): Promise<void> {
  const email = requireEnv('COLAB_GOOGLE_EMAIL');
  const password = requireEnv('COLAB_GOOGLE_PASSWORD');
  const client = new ColabClient();

  if (process.env.COLAB_RESET_SESSION === '1') {
    await rm(client.paths.browserProfile, { recursive: true, force: true });
    console.log('Reset browser profile.');
  }

  await client.auth.login({
    email,
    password,
    headless: process.env.COLAB_HEADLESS !== '0',
    exportState: true,
    twoFactorWaitMs: 300_000,
  });

  console.log('Logged in. Session:', client.paths.browserProfile);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
