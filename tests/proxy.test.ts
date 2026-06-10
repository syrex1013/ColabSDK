import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { ColabProxy } from '../src/proxy/ColabProxy.js';
import { COLAB_URL, COLAB_NOTEBOOK_PATH, REQUIRED_TOOLS, TOOL_GET_CELLS } from '../src/constants.js';
import { ConnectionTimeoutError, NotConnectedError, RpcError, ToolNotAvailableError } from '../src/errors/index.js';
import { connectMockColabClient } from './helpers/mockMcpClient.js';

describe('ColabProxy', () => {
  it('generates connection URL with token and port', async () => {
    const proxy = new ColabProxy();
    await proxy.start();

    try {
      const url = proxy.getConnectionUrl();
      expect(url).toContain(COLAB_URL);
      expect(url).toContain(COLAB_NOTEBOOK_PATH);
      expect(url).toContain(`mcpProxyToken=${proxy.token}`);
      expect(url).toContain(`mcpProxyPort=${proxy.port}`);
      expect(proxy.port).toBeGreaterThan(0);
    } finally {
      await proxy.stop();
    }
  });

  it('reports disconnected before client attaches', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    try {
      expect(proxy.isConnected).toBe(false);
      expect(proxy.connectionInfo().connectionState).toBe('disconnected');
    } finally {
      await proxy.stop();
    }
  });

  it('rejects connection without valid token', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}`, 'mcp', {
        headers: { Authorization: 'Bearer wrong' },
      });
      const closed = await Promise.race([
        new Promise<boolean>((resolve) => {
          ws.on('close', () => resolve(true));
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      expect(closed).toBe(true);
      expect(proxy.isConnected).toBe(false);
    } finally {
      await proxy.stop();
    }
  });

  it('handshakes and lists tools', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    let ws: WebSocket | null = null;
    try {
      ws = await connectMockColabClient(proxy.port, proxy.token);
      await proxy.waitForConnection(5000);
      expect(proxy.isConnected).toBe(true);
      const tools = await proxy.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining([...REQUIRED_TOOLS]));
      expect(proxy.connectionInfo().connectedForSeconds).toBeDefined();
    } finally {
      ws?.close();
      await proxy.stop();
    }
  });

  it('calls tools and returns structured content', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    let ws: WebSocket | null = null;
    try {
      ws = await connectMockColabClient(proxy.port, proxy.token, {
        onToolCall: (name) => ({
          structuredContent: { cells: name === TOOL_GET_CELLS ? [{ cellId: '1', cellType: 'code', source: '' }] : {} },
        }),
      });
      await proxy.waitForConnection(5000);
      const result = await proxy.callTool(TOOL_GET_CELLS, {});
      expect(result.structuredContent).toBeDefined();
    } finally {
      ws?.close();
      await proxy.stop();
    }
  });

  it('validates required tools', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    let ws: WebSocket | null = null;
    try {
      ws = await connectMockColabClient(proxy.port, proxy.token);
      await proxy.waitForConnection(5000);
      await expect(proxy.validateRequiredTools()).resolves.toBeUndefined();
    } finally {
      ws?.close();
      await proxy.stop();
    }
  });

  it('throws when required tool missing', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    let ws: WebSocket | null = null;
    try {
      ws = await connectMockColabClient(proxy.port, proxy.token, {
        onToolCall: () => ({}),
      });
      await proxy.waitForConnection(5000);
      vi.spyOn(proxy, 'listTools').mockResolvedValue([{ name: 'add_code_cell' }]);
      await expect(proxy.validateRequiredTools()).rejects.toThrow(ToolNotAvailableError);
    } finally {
      ws?.close();
      await proxy.stop();
    }
  });

  it('times out waiting for connection', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    try {
      await expect(proxy.waitForConnection(50)).rejects.toThrow(ConnectionTimeoutError);
    } finally {
      await proxy.stop();
    }
  });

  it('throws when calling tool before connection', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    try {
      await expect(proxy.callTool('get_cells', {})).rejects.toThrow(NotConnectedError);
    } finally {
      await proxy.stop();
    }
  });

  it('throws when getting URL before start', () => {
    const proxy = new ColabProxy();
    expect(() => proxy.getConnectionUrl()).toThrow(NotConnectedError);
  });

  it('rejects second simultaneous connection', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    let ws1: WebSocket | null = null;
    let ws2: WebSocket | null = null;
    try {
      ws1 = await connectMockColabClient(proxy.port, proxy.token);
      await proxy.waitForConnection(5000);
      ws2 = new WebSocket(`ws://127.0.0.1:${proxy.port}`, 'mcp', {
        headers: { Authorization: `Bearer ${proxy.token}` },
      });
      await new Promise<void>((resolve) => {
        ws2!.on('close', () => resolve());
      });
    } finally {
      ws1?.close();
      ws2?.close();
      await proxy.stop();
    }
  });

  it('surfaces RPC errors', async () => {
    const proxy = new ColabProxy();
    await proxy.start();
    let ws: WebSocket | null = null;
    try {
      ws = await connectMockColabClient(proxy.port, proxy.token, {
        onToolCall: () => {
          throw new Error('unused');
        },
      });
      await proxy.waitForConnection(5000);

      ws.removeAllListeners('message');
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id?: number; method?: string };
        if (msg.method === 'tools/call' && msg.id !== undefined) {
          ws!.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: 'tool failed' },
            }),
          );
        }
      });

      await expect(proxy.callTool('add_code_cell', {})).rejects.toThrow(RpcError);
    } finally {
      ws?.close();
      await proxy.stop();
    }
  });
});
