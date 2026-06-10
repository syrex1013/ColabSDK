import { ColabClient } from '../src/index.js';

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

async function main(): Promise<void> {
  const email = env('COLAB_GOOGLE_EMAIL');
  const password = env('COLAB_GOOGLE_PASSWORD');
  if (!email || !password) {
    throw new Error('Set COLAB_GOOGLE_EMAIL and COLAB_GOOGLE_PASSWORD');
  }

  const client = new ColabClient();

  try {
    if (!(await client.auth.isLoggedIn())) {
      console.log('Logging in...');
      await client.auth.login({ email, password, headless: false, twoFactorWaitMs: 300_000 });
    } else {
      console.log('Using saved session.');
    }

    console.log('Connecting...');
    await client.connect({ headless: false });

    const page = (client as unknown as { browser: { activePage: { screenshot: Function } } }).browser
      .activePage;
    if (page) {
      await page.screenshot({ path: '.colabdev/debug/after-connect.png', fullPage: true });
    }

    console.log('Running code...');
    const result = await client.execute.runCode('print("rpc-test-ok")');
    console.log('SUCCESS stdout:', result.stdout.trim());
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
