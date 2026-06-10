/**
 * Connect to Colab and execute Python code.
 *
 * Prerequisites: run example:login first.
 *
 *   bun run example:run
 */

import { createAuthenticatedClient, connectHeadless } from './_helpers.js';

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();

  try {
    await connectHeadless(client);

    const result = await client.execute.runCode(
      `import sys\nprint("Hello from ColabSDK")\nprint("Python:", sys.version.split()[0])`,
      { cleanup: true },
    );

    console.log('stdout:\n' + result.stdout.trim());
    if (result.stderr) console.log('stderr:\n' + result.stderr.trim());
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
