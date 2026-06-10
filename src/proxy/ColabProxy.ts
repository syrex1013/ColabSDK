import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { WebSocket, WebSocketServer } from 'ws';

import {
  COLAB_NOTEBOOK_PATH,
  COLAB_URL,
  CONNECTION_TIMEOUT_MS,
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  REQUIRED_TOOLS,
  RPC_REQUEST_TIMEOUT_MS,
  WS_HOST,
  WS_TOKEN_LENGTH,
} from '../constants.js';
import {
  ConnectionTimeoutError,
  NotConnectedError,
  RpcError,
  ToolNotAvailableError,
  wrapError,
} from '../errors/index.js';
import type { ConnectionInfo, ConnectionState, RpcTool } from '../types/index.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number | string; message?: string; data?: unknown };
}

export class ColabProxy extends EventEmitter {
  private server: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private connectionResolve: (() => void) | null = null;
  private readonly responses = new Map<number, (msg: JsonRpcResponse) => void>();
  private nextId = 1;
  private initialized = false;
  private connectedAt: number | null = null;
  private lastCloseCode: number | null = null;
  private _state: ConnectionState = 'disconnected';

  readonly token: string;
  port = 0;

  constructor() {
    super();
    this.token = randomBytes(WS_TOKEN_LENGTH).toString('base64url');
  }

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.initialized && this._state === 'connected';
  }

  connectionInfo(): ConnectionInfo {
    return {
      connected: this.isConnected,
      connectionState: this._state,
      connectedForSeconds:
        this.connectedAt !== null && this.isConnected
          ? Math.round((Date.now() - this.connectedAt) / 1000)
          : undefined,
      lastCloseCode: this.lastCloseCode ?? undefined,
      port: this.port || undefined,
    };
  }

  getConnectionUrl(notebookPath = COLAB_NOTEBOOK_PATH): string {
    if (!this.port) {
      throw new NotConnectedError('Proxy server not started. Call start() first.');
    }
    return `${COLAB_URL}${notebookPath}#mcpProxyToken=${this.token}&mcpProxyPort=${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.resetConnectionEvent();

    this.server = new WebSocketServer({
      host: WS_HOST,
      port: 0,
      perMessageDeflate: false,
      handleProtocols: (protocols) => {
        if (protocols.has('mcp')) return 'mcp';
        return protocols.values().next().value ?? false;
      },
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('listening', () => resolve());
      this.server!.once('error', reject);
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine WebSocket server port');
    }
    this.port = address.port;

    this.server.on('connection', (ws, req) => {
      void this.handleConnection(ws, req);
    });
  }

  async waitForConnection(timeoutMs = CONNECTION_TIMEOUT_MS): Promise<boolean> {
    if (this.isConnected) return true;
    if (!this.connectionPromise) {
      throw new NotConnectedError('Proxy server not started.');
    }

    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    });

    const connected = await Promise.race([
      this.connectionPromise.then(() => true),
      timeout,
    ]);

    if (!connected) {
      throw new ConnectionTimeoutError();
    }
    return true;
  }

  async listTools(): Promise<RpcTool[]> {
    const result = await this.sendRequest('tools/list');
    return (result.tools as RpcTool[] | undefined) ?? [];
  }

  async validateRequiredTools(): Promise<void> {
    const tools = await this.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const required of REQUIRED_TOOLS) {
      if (!names.has(required)) {
        throw new ToolNotAvailableError(required);
      }
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return this.sendRequest('tools/call', { name, arguments: args }, timeoutMs);
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.initialized = false;
    this._state = 'disconnected';
    this.port = 0;
    this.resetConnectionEvent();
  }

  private resetConnectionEvent(): void {
    this.connectionPromise = new Promise<void>((resolve) => {
      this.connectionResolve = resolve;
    });
  }

  private validateRequest(req: { url?: string; headers: Record<string, string | string[] | undefined> }): boolean {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string') {
      const [, token] = authHeader.split(' ');
      if (token === this.token) return true;
    }

    const url = req.url ?? '';
    return url.includes(`access_token=${this.token}`);
  }

  private async handleConnection(
    ws: WebSocket,
    req: { url?: string; headers: Record<string, string | string[] | undefined> },
  ): Promise<void> {
    if (!this.validateRequest(req)) {
      ws.close(1008, 'Forbidden');
      return;
    }

    if (this.ws) {
      ws.close(1013, 'Already connected');
      return;
    }

    this.ws = ws;
    this._state = 'connecting';

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as JsonRpcResponse;
        const id = msg.id;
        if (id !== undefined && this.responses.has(id)) {
          this.responses.get(id)!(msg);
          this.responses.delete(id);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', (code) => {
      this.lastCloseCode = code;
      this.ws = null;
      this.initialized = false;
      this._state = code === 1001 ? 'expired' : 'disconnected';
      this.emit('disconnected', code);
    });

    try {
      await this.doInitialize();
      this._state = 'connected';
      this.connectedAt = Date.now();
      this.connectionResolve?.();
      this.emit('connected');
    } catch (err) {
      this._state = 'disconnected';
      ws.close();
      this.ws = null;
      throw wrapError(err, 'MCP handshake failed');
    }
  }

  private async doInitialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'colab-sdk', version: '0.1.0' },
    });
    await this.sendNotification('notifications/initialized');
    this.initialized = true;
  }

  private async sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (!this.ws) {
      throw new NotConnectedError();
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
    };
    if (params !== undefined) request.params = params;

    const resultPromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new RpcError(`RPC timeout for method: ${method}`));
      }, timeoutMs);

      this.responses.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    this.ws.send(JSON.stringify(request));
    const response = await resultPromise;

    if (response.error) {
      throw new RpcError(
        response.error.message ?? 'RPC error',
        response.error.code,
        response.error.data,
      );
    }

    return response.result ?? {};
  }

  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.ws) {
      throw new NotConnectedError();
    }
    const msg: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, method };
    if (params !== undefined) msg.params = params;
    this.ws.send(JSON.stringify(msg));
  }
}
