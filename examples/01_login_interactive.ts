/**
 * Interactive Google login (supports 2FA in a visible browser).
 *
 *   bun run example:login
 *   COLAB_HEADLESS=1 bun run example:login   # headless (only if no 2FA)
 */

import { ColabClient } from '../src/index.js';

async function main(): Promise<void> {
  const client = new ColabClient();
  const headless = process.env.COLAB_HEADLESS === '1';

  console.log(`Profile: ${client.paths.browserProfile}`);

  await client.auth.login({
    headless,
    exportState: true,
    twoFactorWaitMs: 300_000,
  });

  const ok = await client.auth.isLoggedIn();
  console.log(ok ? 'Session saved. You can now run other examples.' : 'Login probe failed.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
