import { DEFAULT_KEEPALIVE_INTERVAL_MS } from '../constants.js';
import { NotConnectedError, wrapError } from '../errors/index.js';
import { AuthManager } from '../auth/AuthManager.js';
import { BrowserSession } from '../browser/BrowserSession.js';
import { CellManager } from '../cells/CellManager.js';
import { ExecutionManager } from '../execution/ExecutionManager.js';
import { KeepAlive } from '../keepalive/KeepAlive.js';
import { ColabProxy } from '../proxy/ColabProxy.js';
import { RuntimeManager } from '../runtime/RuntimeManager.js';
import { ColabDevPaths } from '../storage/ColabDevPaths.js';
import type { ConnectOptions, ConnectionInfo } from '../types/index.js';

export class ColabClient implements AsyncDisposable {
  readonly paths: ColabDevPaths;
  readonly auth: AuthManager;
  readonly cells: CellManager;
  readonly execute: ExecutionManager;
  readonly runtime: RuntimeManager;

  private readonly proxy = new ColabProxy();
  private readonly browser: BrowserSession;
  private keepAlive: KeepAlive | null = null;
  private connected = false;

  constructor(rootDir?: string) {
    this.paths = new ColabDevPaths(rootDir);
    this.browser = new BrowserSession(this.paths);
    this.auth = new AuthManager(this.browser);
    this.cells = new CellManager(() => this.requireProxy());
    this.execute = new ExecutionManager(() => this.requireProxy(), this.cells, this.browser);
    this.runtime = new RuntimeManager(() => this.requireProxy(), this.browser);
  }

  async connect(options: ConnectOptions = {}): Promise<ConnectionInfo> {
    try {
      const settings = await this.paths.loadSettings();
      const headless = options.headless ?? settings.headless ?? true;
      const keepAliveIntervalMs =
        options.keepAliveIntervalMs ?? settings.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;

      await this.proxy.start();
      const url = options.notebookUrl ?? this.proxy.getConnectionUrl();

      const page = await this.browser.connect(url, {
        headless,
        email: options.email,
        password: options.password,
      });
      await this.proxy.waitForConnection();
      await this.proxy.validateRequiredTools();
      await this.browser.ensureRuntimeConnected(120_000);

      this.connected = true;

      this.keepAlive = new KeepAlive(keepAliveIntervalMs);
      await this.keepAlive.start(page);

      if (options.gpu) {
        await this.runtime.select(options.gpu);
        await this.proxy.waitForConnection();
      }
      await this.paths.saveSession({
        port: this.proxy.port,
        token: this.proxy.token,
        connectedAt: new Date().toISOString(),
        notebookUrl: url,
      });

      return this.status();
    } catch (err) {
      await this.disconnect();
      throw wrapError(err, 'Failed to connect to Colab');
    }
  }

  async createNotebook(): Promise<string> {
    if (!this.proxy.port) {
      await this.proxy.start();
    }
    return this.proxy.getConnectionUrl();
  }

  async openNotebook(url: string, options: Omit<ConnectOptions, 'notebookUrl'> = {}): Promise<ConnectionInfo> {
    return this.connect({ ...options, notebookUrl: url });
  }

  status(): ConnectionInfo {
    return this.proxy.connectionInfo();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.keepAlive?.stop();
    this.keepAlive = null;
    await this.browser.close();
    await this.proxy.stop();
    await this.paths.clearSession();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  private requireProxy(): ColabProxy {
    if (!this.connected || !this.proxy.isConnected) {
      throw new NotConnectedError();
    }
    return this.proxy;
  }
}
