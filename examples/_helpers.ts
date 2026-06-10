import { ColabClient } from '../src/index.js';

/** Create a client and ensure a saved Google session exists. */
export async function createAuthenticatedClient(): Promise<ColabClient> {
  const client = new ColabClient();

  if (!(await client.auth.isLoggedIn())) {
    console.log('No saved session. Starting interactive login (2FA supported)...');
    await client.auth.login({ exportState: true });
  }

  return client;
}

/** Connect headless unless COLAB_HEADLESS=0. */
export async function connectHeadless(client: ColabClient) {
  const headless = process.env.COLAB_HEADLESS !== '0';
  const info = await client.connect({ headless });
  console.log('Connected:', info);
  return info;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}
