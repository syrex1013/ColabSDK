import { LoginRequiredError, TwoFactorPendingError, wrapError } from '../errors/index.js';
import type { BrowserSession } from '../browser/BrowserSession.js';
import type { LoginOptions } from '../types/index.js';

export class AuthManager {
  constructor(private readonly browser: BrowserSession) {}

  async login(options: LoginOptions = {}): Promise<void> {
    try {
      if (options.email && options.password) {
        await this.browser.loginWithCredentials(options.email, options.password, {
          headless: options.headless ?? false,
          remoteCdpPort: options.remoteCdpPort,
          exportState: options.exportState,
          twoFactorWaitMs: options.twoFactorWaitMs,
        });
        return;
      }

      await this.browser.loginInteractive({
        headless: options.headless ?? false,
        remoteCdpPort: options.remoteCdpPort,
        exportState: options.exportState,
      });
    } catch (err) {
      if (options.allowHeadedFallback && err instanceof LoginRequiredError) {
        throw new TwoFactorPendingError(undefined, err);
      }
      throw wrapError(err, 'Authentication failed');
    }
  }

  async isLoggedIn(): Promise<boolean> {
    return this.browser.probeLogin(true);
  }
}
