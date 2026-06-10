import { ColabClient } from '../src/index.js';

async function main(): Promise<void> {
  const client = new ColabClient();

  try {
    console.log(`Using data directory: ${client.paths.root}`);

    if (!(await client.auth.isLoggedIn())) {
      console.log('Not logged in. Run: bun run colab-dev login');
      console.log('Or call await client.auth.login() for interactive Google login (2FA supported).');
      await client.auth.login();
    }

    console.log('Connecting to Colab (headless)...');
    const info = await client.connect({ headless: true });
    console.log('Connected:', info);

    const result = await client.execute.runCode('print("ColabSDK OK")', { cleanup: true });
    console.log('stdout:', result.stdout.trim());
    if (result.stderr) console.log('stderr:', result.stderr);

    const cells = await client.cells.list();
    console.log(`Notebook has ${cells.length} cell(s)`);
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
