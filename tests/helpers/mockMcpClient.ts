import WebSocket from 'ws';

import { JSONRPC_VERSION, REQUIRED_TOOLS } from '../../src/constants.js';

export interface MockMcpHandlers {
  onToolCall?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
}

export async function connectMockColabClient(
  port: number,
  token: string,
  handlers: MockMcpHandlers = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mcp', {
    headers: { Authorization: `Bearer ${token}` },
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (msg.method === 'initialize' && msg.id !== undefined) {
      ws.send(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock' } },
        }),
      );
      return;
    }

    if (msg.method === 'notifications/initialized') {
      return;
    }

    if (msg.method === 'tools/list' && msg.id !== undefined) {
      ws.send(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: msg.id,
          result: { tools: REQUIRED_TOOLS.map((name) => ({ name, description: name })) },
        }),
      );
      return;
    }

    if (msg.method === 'tools/call' && msg.id !== undefined) {
      const name = msg.params?.name ?? '';
      const args = msg.params?.arguments ?? {};
      const result = handlers.onToolCall?.(name, args) ?? { structuredContent: {} };
      ws.send(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: msg.id, result }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return ws;
}
