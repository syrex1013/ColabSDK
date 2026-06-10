/**
 * Focused auth-only test with step timeouts (no full connect/run hang).
 *
 *   COLAB_GOOGLE_EMAIL=... COLAB_GOOGLE_PASSWORD=... bun run examples/auth_login.ts
 */

import { rm } from 'node:fs/promises';

import { ColabClient } from '../src/index.js';

const TIMEOUT_MS = Number(process.env.COLAB_AUTH_TIMEOUT_MS ?? 180_000);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const email = requireEnv('COLAB_GOOGLE_EMAIL');
  const password = requireEnv('COLAB_GOOGLE_PASSWORD');
  const client = new ColabClient();

  if (process.env.COLAB_RESET_SESSION === '1') {
    console.log('Resetting browser profile...');
    await rm(client.paths.browserProfile, { recursive: true, force: true });
  }

  const timer = setTimeout(() => {
    console.error(`Auth timed out after ${TIMEOUT_MS}ms`);
    process.exit(1);
  }, TIMEOUT_MS);

  try {
    console.log('Logging in...');
    await client.auth.login({
      email,
      password,
      headless: process.env.COLAB_HEADLESS !== '0',
      twoFactorWaitMs: TIMEOUT_MS,
      exportState: true,
    });

    const ok = await client.auth.isLoggedIn();
    if (!ok) {
      throw new Error('Login finished but session probe failed');
    }

    console.log('Logged in successfully. Session saved to .colabdev/browser-profile');
  } finally {
    clearTimeout(timer);
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
