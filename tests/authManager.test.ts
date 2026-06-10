import { describe, expect, it, vi } from 'vitest';

import { AuthManager } from '../src/auth/AuthManager.js';
import { LoginRequiredError, TwoFactorPendingError } from '../src/errors/index.js';

function createBrowser() {
  return {
    loginWithCredentials: vi.fn().mockResolvedValue(undefined),
    loginInteractive: vi.fn().mockResolvedValue(undefined),
    probeLogin: vi.fn().mockResolvedValue(true),
  };
}

describe('AuthManager', () => {
  it('logs in with credentials when email and password provided', async () => {
    const browser = createBrowser();
    const auth = new AuthManager(browser as never);
    await auth.login({ email: 'a@b.com', password: 'secret', headless: true });
    expect(browser.loginWithCredentials).toHaveBeenCalledWith('a@b.com', 'secret', {
      headless: true,
      remoteCdpPort: undefined,
      exportState: undefined,
      twoFactorWaitMs: undefined,
    });
    expect(browser.loginInteractive).not.toHaveBeenCalled();
  });

  it('falls back to interactive login without credentials', async () => {
    const browser = createBrowser();
    const auth = new AuthManager(browser as never);
    await auth.login({ exportState: true });
    expect(browser.loginInteractive).toHaveBeenCalledWith({
      headless: false,
      remoteCdpPort: undefined,
      exportState: true,
    });
  });

  it('maps login required to two factor pending when allowed', async () => {
    const browser = createBrowser();
    browser.loginInteractive.mockRejectedValue(new LoginRequiredError());
    const auth = new AuthManager(browser as never);
    await expect(auth.login({ allowHeadedFallback: true })).rejects.toThrow(TwoFactorPendingError);
  });

  it('wraps other auth failures', async () => {
    const browser = createBrowser();
    browser.loginInteractive.mockRejectedValue(new Error('browser crashed'));
    const auth = new AuthManager(browser as never);
    await expect(auth.login()).rejects.toThrow('browser crashed');
  });

  it('probes login state', async () => {
    const browser = createBrowser();
    browser.probeLogin.mockResolvedValue(false);
    const auth = new AuthManager(browser as never);
    expect(await auth.isLoggedIn()).toBe(false);
    expect(browser.probeLogin).toHaveBeenCalledWith(true);
  });
});
