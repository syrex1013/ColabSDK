import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotConnectedError } from '../src/errors/index.js';

const mockProxy = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  getConnectionUrl: vi.fn(() => 'https://colab.research.google.com/notebooks/empty.ipynb#mcpProxyToken=tok&mcpProxyPort=1'),
  waitForConnection: vi.fn().mockResolvedValue(true),
  validateRequiredTools: vi.fn().mockResolvedValue(undefined),
  connectionInfo: vi.fn(() => ({ connected: true, connectionState: 'connected' as const, port: 1 })),
  port: 1,
  token: 'tok',
  isConnected: true,
  callTool: vi.fn(),
};

const mockPage = { evaluate: vi.fn().mockResolvedValue(undefined) };

const mockBrowser = {
  connect: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  ensureRuntimeConnected: vi.fn().mockResolvedValue(undefined),
  selectRuntime: vi.fn().mockResolvedValue(undefined),
  probeLogin: vi.fn().mockResolvedValue(true),
};

vi.mock('../src/proxy/ColabProxy.js', () => ({
  ColabProxy: vi.fn(() => mockProxy),
}));

vi.mock('../src/browser/BrowserSession.js', () => ({
  BrowserSession: vi.fn(() => mockBrowser),
}));

describe('ColabClient', () => {
  let tempDir: string;
  let ColabClient: typeof import('../src/client/ColabClient.js').ColabClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProxy.isConnected = true;
    tempDir = await mkdtemp(join(tmpdir(), 'colab-client-'));
    ({ ColabClient } = await import('../src/client/ColabClient.js'));
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('exposes managers and paths', () => {
    const client = new ColabClient(tempDir);
    expect(client.paths.root).toBe(tempDir);
    expect(client.auth).toBeDefined();
    expect(client.cells).toBeDefined();
    expect(client.execute).toBeDefined();
    expect(client.runtime).toBeDefined();
    expect(client.workflows).toBeDefined();
    expect(client.files).toBeDefined();
  });

  it('connects, saves session, and returns status', async () => {
    const client = new ColabClient(tempDir);
    const info = await client.connect({ headless: true });
    expect(info.connected).toBe(true);
    expect(mockProxy.start).toHaveBeenCalled();
    expect(mockBrowser.connect).toHaveBeenCalled();
    const session = await client.paths.loadSession();
    expect(session?.port).toBe(1);
    await client.disconnect();
  });

  it('defaults to headless mode when no options provided', async () => {
    const client = new ColabClient(tempDir);
    await client.connect();
    expect(mockBrowser.connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headless: true }),
    );
    await client.disconnect();
  });

  it('selects GPU on connect when requested', async () => {
    const client = new ColabClient(tempDir);
    await client.connect({ headless: true, gpu: 't4' });
    expect(mockBrowser.selectRuntime).toHaveBeenCalledWith('t4');
    await client.disconnect();
  });

  it('disconnects on connect failure', async () => {
    mockBrowser.connect.mockRejectedValueOnce(new Error('nav failed'));
    const client = new ColabClient(tempDir);
    await expect(client.connect()).rejects.toThrow('nav failed');
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(mockProxy.stop).toHaveBeenCalled();
  });

  it('createNotebook returns MCP URL', async () => {
    const client = new ColabClient(tempDir);
    mockProxy.port = 0;
    const url = await client.createNotebook();
    expect(url).toContain('mcpProxyToken=');
    expect(mockProxy.start).toHaveBeenCalled();
    await client.disconnect();
  });

  it('openNotebook delegates to connect', async () => {
    const client = new ColabClient(tempDir);
    const spy = vi.spyOn(client, 'connect');
    await client.openNotebook('https://example.com/nb', { headless: false });
    expect(spy).toHaveBeenCalledWith({ headless: false, notebookUrl: 'https://example.com/nb' });
    await client.disconnect();
  });

  it('status reports proxy connection info', () => {
    const client = new ColabClient(tempDir);
    expect(client.status().connectionState).toBe('connected');
  });

  it('throws NotConnectedError when calling cells before connect', async () => {
    const client = new ColabClient(tempDir);
    mockProxy.isConnected = false;
    await expect(client.cells.list()).rejects.toThrow(NotConnectedError);
  });

  it('supports async disposal', async () => {
    const client = new ColabClient(tempDir);
    await client.connect();
    await client[Symbol.asyncDispose]();
    expect(mockProxy.stop).toHaveBeenCalled();
  });
});
