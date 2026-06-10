import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page } from 'playwright-core';

import {
  COLAB_URL,
  GPU_TYPES,
  MCP_ACCEPT_BUTTON_TEXT,
  PLAYWRIGHT_ACCEPT_TIMEOUT_MS,
  PLAYWRIGHT_NAV_TIMEOUT_MS,
  RUNTIME_DIALOG_TIMEOUT_MS,
} from '../constants.js';
import {
  BrowserError,
  LoginRequiredError,
  TwoFactorPendingError,
  UploadWidgetNotFoundError,
  wrapError,
} from '../errors/index.js';
import { mergeUploadDomState, type CellUploadDomState } from '../files/cellUploadUtils.js';
import type { ColabDevPaths } from '../storage/ColabDevPaths.js';
import type { RuntimeType } from '../types/index.js';
import {
  buildChallengeUrl,
  clickAccountTile,
  clickByVisibleText,
  clickColabSignInModal,
  clickGoogleChallengeOption,
  clickGoogleChallengeOptionPartial,
  fillVisibleInput,
  isTwoFactorChallengeVisible,
  hasColabSignInModal,
  hasColabSignInWall,
  hasGoogleAuthCookies,
  hasPasswordInput,
  hasVisibleColabSignInHeader,
  isColabAppUrl,
  isColabAuthenticated,
  isGoogleAuthInProgress,
  pageHasVisibleText,
  readVisibleInputValue,
  waitForAuthSurfaceChange,
} from './domActions.js';

export interface BrowserConnectOptions {
  headless?: boolean;
  remoteCdpPort?: number;
  humanize?: boolean;
  exportState?: boolean;
  twoFactorWaitMs?: number;
  email?: string;
  password?: string;
}

export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private authStepCounter = 0;
  private passkeyBypassAttempts = 0;
  private choosePasswordAttempts = 0;
  private tapYesClicked = false;
  private awaitingTwoFactorApproval = false;
  private lastConnectOptions: BrowserConnectOptions = {};

  constructor(private readonly paths: ColabDevPaths) {}

  get activePage(): Page | null {
    return this.page;
  }

  async connect(url: string, options: BrowserConnectOptions = {}): Promise<Page> {
    const headless = options.headless ?? true;
    this.lastConnectOptions = options;

    try {
      await this.paths.ensureDirs();

      const args = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];
      if (options.remoteCdpPort) {
        args.push(`--remote-debugging-port=${options.remoteCdpPort}`);
      }

      this.context = await launchPersistentContext({
        userDataDir: this.paths.browserProfile,
        headless,
        humanize: options.humanize ?? true,
        args,
      });

      const pages = this.context.pages();
      this.page = pages[0] ?? (await this.context.newPage());

      for (const p of this.context.pages()) {
        if (p !== this.page) await p.close();
      }

      await this.page.goto(url, {
        timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });

      await this.waitForAuthSurface(this.page, 8_000);
      await this.resolveAuthWall(this.page, options);
      await this.dismissColabSignInModalIfPresent(this.page);

      if (!this.page.url().includes('mcpProxyPort')) {
        await this.page.goto(url, {
          timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
          waitUntil: 'domcontentloaded',
        });
      }

      if (await this.needsGoogleSignIn(this.page)) {
        await this.resolveAuthWall(this.page, options);
        await this.page.goto(url, {
          timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
          waitUntil: 'domcontentloaded',
        });
      }

      await this.dismissColabSignInModalIfPresent(this.page);
      await this.acceptMcpDialog(this.page);
      await this.dismissColabSignInModalIfPresent(this.page);

      return this.page;
    } catch (err) {
      await this.saveDebugScreenshot('connect-failure');
      throw wrapError(err, 'Failed to connect browser to Colab');
    }
  }

  async loginWithCredentials(
    email: string,
    password: string,
    options: BrowserConnectOptions = {},
  ): Promise<void> {
    this.lastConnectOptions = { ...options, email, password };

    try {
      await this.paths.ensureDirs();

      const args = ['--disable-blink-features=AutomationControlled', '--no-first-run'];
      if (options.remoteCdpPort) {
        args.push(`--remote-debugging-port=${options.remoteCdpPort}`);
      }

      this.context = await launchPersistentContext({
        userDataDir: this.paths.browserProfile,
        headless: options.headless ?? false,
        humanize: true,
        args,
      });

      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto(COLAB_URL, {
        timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });

      await this.waitForAuthSurface(this.page, 10_000);
      await this.resolveAuthWall(this.page, { ...options, email, password });
      await this.ensureAuthenticatedColabPage();
      await this.persistAuthSession();
    } catch (err) {
      await this.saveDebugScreenshot('credential-login-failure');
      if (
        this.awaitingTwoFactorApproval &&
        err instanceof LoginRequiredError &&
        /timed out|time limit/i.test(err.message)
      ) {
        throw new TwoFactorPendingError(
          '2FA phone approval timed out. Approve the sign-in on your phone and re-run the test.',
          err,
        );
      }
      throw wrapError(err, 'Credential login failed');
    } finally {
      await this.close();
    }
  }

  async loginInteractive(options: BrowserConnectOptions = {}): Promise<void> {
    try {
      await this.paths.ensureDirs();

      const args = ['--disable-blink-features=AutomationControlled', '--no-first-run'];
      if (options.remoteCdpPort) {
        args.push(`--remote-debugging-port=${options.remoteCdpPort}`);
      }

      this.context = await launchPersistentContext({
        userDataDir: this.paths.browserProfile,
        headless: false,
        humanize: true,
        args,
      });

      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto(COLAB_URL, {
        timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });

      if (options.remoteCdpPort) {
        console.log(
          `Remote CDP enabled on port ${options.remoteCdpPort}. Complete login in the browser or via DevTools.`,
        );
      } else {
        console.log('Complete Google login (including 2FA if prompted) in the browser window.');
      }

      await this.waitForLogin(this.page, 300_000);
      await this.ensureAuthenticatedColabPage();
      await this.persistAuthSession();

      if (options.exportState) {
        console.log(`Auth state exported to ${join(this.paths.root, 'auth.state.json')}`);
      }
    } catch (err) {
      await this.saveDebugScreenshot('login-failure');
      throw wrapError(err, 'Login failed');
    } finally {
      await this.close();
    }
  }

  async probeLogin(headless = true): Promise<boolean> {
    try {
      await this.paths.ensureDirs();
      this.context = await launchPersistentContext({
        userDataDir: this.paths.browserProfile,
        headless,
        humanize: true,
      });

      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto(COLAB_URL, {
        timeout: PLAYWRIGHT_NAV_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });

      await this.waitForAuthSurface(this.page, 15_000);
      await this.page.waitForLoadState('networkidle').catch(() => undefined);

      if (await isColabAuthenticated(this.page)) {
        return true;
      }

      return (await hasGoogleAuthCookies(this.context)) && !(await hasColabSignInWall(this.page));
    } catch {
      return false;
    } finally {
      await this.close();
    }
  }

  async selectRuntime(gpu: RuntimeType): Promise<void> {
    const page = this.requirePage();
    const displayName = GPU_TYPES[gpu];
    if (!displayName) {
      throw new BrowserError(`Unknown GPU type: ${gpu}`);
    }

    try {
      await page.getByText('Runtime', { exact: true }).first().click();
      await page.getByText('Change runtime type').waitFor({
        timeout: RUNTIME_DIALOG_TIMEOUT_MS,
        state: 'visible',
      });
      await page.getByText('Change runtime type').click();
      await page.getByRole('radio', { name: displayName }).waitFor({
        timeout: RUNTIME_DIALOG_TIMEOUT_MS,
        state: 'visible',
      });
      await page.getByRole('radio', { name: displayName }).click();
      await page.getByRole('button', { name: 'Save' }).click();
    } catch (err) {
      await this.saveDebugScreenshot('runtime-change-failure');
      throw new BrowserError(`Failed to change runtime to ${gpu}`, err);
    }
  }

  async interruptExecution(): Promise<void> {
    const page = this.requirePage();
    try {
      const stopButton = page.getByRole('button', { name: /interrupt|stop/i });
      if (await stopButton.count()) {
        await stopButton.first().click();
        return;
      }

      await page.keyboard.press('Control+C');
      await page.keyboard.press('Meta+C');
    } catch (err) {
      throw new BrowserError('Failed to interrupt execution', err);
    }
  }

  /** Run a notebook cell from the Colab UI so MCP stays free for other tool calls. */
  async runCellViaBrowser(cellId: string, cellIndex: number): Promise<void> {
    const page = this.requirePage();
    try {
      const result = await page.evaluate(
        ({ id, index }) => {
          const findCell = (): Element | null => {
            const escaped = CSS.escape(id);
            const byAttr = document.querySelector(`[data-cell-id="${id}"], #${escaped}`);
            if (byAttr) return byAttr;
            const cells = document.querySelectorAll('colab-cell, .cell');
            return cells.item(index) ?? null;
          };

          const tryClickRun = (root: Element | Document | ShadowRoot): boolean => {
            const selectors = [
              'colab-run-button',
              '[aria-label*="Run cell" i]',
              '[aria-label*="Play" i]',
              'button[title*="Run" i]',
            ];
            for (const selector of selectors) {
              const button = root.querySelector(selector);
              if (button instanceof HTMLElement) {
                button.click();
                return true;
              }
            }
            if ('querySelectorAll' in root) {
              const elements = Array.from(root.querySelectorAll('*'));
              for (const el of elements) {
                if (el.shadowRoot && tryClickRun(el.shadowRoot)) return true;
              }
            }
            return false;
          };

          const cell = findCell();
          if (!cell) return { ok: false as const, reason: 'cell-not-found' };
          cell.scrollIntoView({ block: 'center' });
          if (tryClickRun(cell)) return { ok: true as const, method: 'button' as const };

          const editor = cell.querySelector(
            '.monaco-editor, textarea, [contenteditable="true"], .inputarea',
          );
          if (editor instanceof HTMLElement) {
            editor.click();
            return { ok: true as const, method: 'keyboard' as const };
          }

          return { ok: false as const, reason: 'no-run-control' };
        },
        { id: cellId, index: cellIndex },
      );

      if (!result.ok) {
        throw new BrowserError(`Failed to run cell ${cellId}: ${result.reason}`);
      }

      if (result.method === 'keyboard') {
        await page.keyboard.press('Control+Enter');
        await page.keyboard.press('Meta+Enter');
      }
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError(`Failed to run cell ${cellId} in browser`, err);
    }
  }

  async waitForCellFileInput(
    cellId: string,
    cellIndex: number,
    timeoutMs = 120_000,
  ): Promise<void> {
    const page = this.requirePage();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const state = await this.readCellUploadState(cellId, cellIndex);
      if (state.hasFileInput) return;
      await page.waitForTimeout(250);
    }

    throw new UploadWidgetNotFoundError(cellId);
  }

  async setCellUploadFiles(cellId: string, cellIndex: number, files: string[]): Promise<void> {
    const page = this.requirePage();
    try {
      const handle = await page.evaluateHandle(
        ({ id, index }) => {
          const findCell = (): Element | null => {
            const escaped = CSS.escape(id);
            const byAttr = document.querySelector(`[data-cell-id="${id}"], #${escaped}`);
            if (byAttr) return byAttr;
            const cells = document.querySelectorAll('colab-cell, .cell');
            return cells.item(index) ?? null;
          };

          const collectInputs = (root: Element | Document | ShadowRoot): HTMLInputElement[] => {
            const inputs: HTMLInputElement[] = [];
            root.querySelectorAll('input[type="file"]').forEach((el) => {
              if (el instanceof HTMLInputElement) inputs.push(el);
            });
            root.querySelectorAll('*').forEach((el) => {
              if (el.shadowRoot) inputs.push(...collectInputs(el.shadowRoot));
            });
            return inputs;
          };

          const cell = findCell();
          if (!cell) return null;
          const inputs = collectInputs(cell);
          return inputs[0] ?? null;
        },
        { id: cellId, index: cellIndex },
      );

      const element = handle.asElement();
      if (!element) {
        await handle.dispose();
        throw new UploadWidgetNotFoundError(cellId);
      }

      await element.setInputFiles(files);
      await handle.dispose();
    } catch (err) {
      if (err instanceof UploadWidgetNotFoundError) throw err;
      throw new BrowserError(`Failed to set upload files on cell ${cellId}`, err);
    }
  }

  async readCellUploadState(cellId: string, cellIndex: number): Promise<CellUploadDomState> {
    const page = this.requirePage();
    const raw = await page.evaluate(
      ({ id, index }) => {
        const findCell = (): Element | null => {
          const escaped = CSS.escape(id);
          const byAttr = document.querySelector(`[data-cell-id="${id}"], #${escaped}`);
          if (byAttr) return byAttr;
          const cells = document.querySelectorAll('colab-cell, .cell');
          return cells.item(index) ?? null;
        };

        const collectInputs = (root: Element | Document | ShadowRoot): HTMLInputElement[] => {
          const inputs: HTMLInputElement[] = [];
          root.querySelectorAll('input[type="file"]').forEach((el) => {
            if (el instanceof HTMLInputElement) inputs.push(el);
          });
          root.querySelectorAll('*').forEach((el) => {
            if (el.shadowRoot) inputs.push(...collectInputs(el.shadowRoot));
          });
          return inputs;
        };

        const cell = findCell();
        if (!cell) {
          return {
            hasFileInput: false,
            fileInputCount: 0,
            textContent: '',
          };
        }

        const inputs = collectInputs(cell);
        const textContent = (cell as HTMLElement).innerText ?? '';
        const progress = cell.querySelector('progress');
        return {
          hasFileInput: inputs.length > 0,
          fileInputCount: inputs.length,
          textContent,
          progressValue: progress ? progress.value : undefined,
          progressMax: progress ? progress.max : undefined,
        };
      },
      { id: cellId, index: cellIndex },
    );

    return mergeUploadDomState(raw);
  }

  async stopRuntime(): Promise<void> {
    const page = this.requirePage();
    try {
      await page.getByText('Runtime', { exact: true }).first().click();
      const disconnect = page.getByText(/Disconnect and delete runtime/i);
      if (await disconnect.count()) {
        await disconnect.first().click();
        const confirm = page.getByRole('button', { name: /OK|Yes|Disconnect/i });
        if (await confirm.count()) {
          await confirm.first().click();
        }
      }
    } catch (err) {
      throw new BrowserError('Failed to stop runtime', err);
    }
  }

  async ensureRuntimeConnected(timeoutMs = 180_000): Promise<void> {
    const page = this.requirePage();

    const clickRuntimeConnect = async (): Promise<void> => {
      await page.evaluate(`(() => {
        for (const host of document.querySelectorAll('colab-connect-button')) {
          host.shadowRoot?.querySelector('#connect')?.click();
        }
      })()`);

      const connectBtn = page.getByRole('button', { name: /^Connect$/i });
      if (await connectBtn.count()) {
        await connectBtn.first().click({ timeout: 3000 }).catch(() => {});
      }
    };

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await hasColabSignInModal(page)) {
        await this.dismissColabSignInModalIfPresent(page);
        await this.resolveAuthWall(page, this.lastConnectOptions);
        await page.waitForTimeout(2000);
      }

      await clickRuntimeConnect();

      if (await hasColabSignInModal(page)) {
        await this.dismissColabSignInModalIfPresent(page);
        await this.resolveAuthWall(page, this.lastConnectOptions);
        await page.waitForTimeout(2000);
        continue;
      }

      const allocating = page.getByText(/Allocating runtime/i);
      const ramDisk = page.getByText(/RAM|Disk/i);
      const connected = page.getByText(/Connected to/i);

      if ((await ramDisk.count()) > 0 || (await connected.count()) > 0) {
        if ((await allocating.count()) === 0) {
          await page.waitForTimeout(5000);
          return;
        }
      }

      await page.waitForTimeout(3000);
    }

    await this.saveDebugScreenshot('runtime-connect-timeout');
    throw new BrowserError('Timed out waiting for Colab runtime to connect');
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
      }
    } catch {
      // ignore close errors
    } finally {
      this.context = null;
      this.page = null;
    }
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new BrowserError('Browser page not available');
    }
    return this.page;
  }

  private isGoogleLoginPage(url: string): boolean {
    return url.includes('accounts.google.com') || url.includes('/signin');
  }

  private async needsGoogleSignIn(page: Page): Promise<boolean> {
    if (await isColabAuthenticated(page)) return false;
    if (this.isGoogleLoginPage(page.url())) return true;
    if (await isGoogleAuthInProgress(page)) return true;
    if (isColabAppUrl(page.url())) return true;
    return false;
  }

  private async waitForAuthSurface(page: Page, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await isColabAuthenticated(page)) return;
      if (this.isGoogleLoginPage(page.url())) return;
      if (await isGoogleAuthInProgress(page)) return;
      if (await hasColabSignInModal(page)) return;
      if (await hasVisibleColabSignInHeader(page)) return;
      await page.waitForTimeout(500);
    }
  }

  private async focusGoogleAuthPage(page: Page): Promise<Page> {
    const context = page.context();
    for (const candidate of context.pages()) {
      if (candidate.url().includes('accounts.google.com')) {
        this.page = candidate;
        return candidate;
      }
    }

    try {
      await page.waitForURL(/accounts\.google\.com/, { timeout: 15_000 });
      return page;
    } catch {
      const popup = await context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
        if (popup.url().includes('accounts.google.com')) {
          this.page = popup;
          return popup;
        }
      }
    }

    return page;
  }

  private async dismissColabSignInModalIfPresent(page: Page): Promise<boolean> {
    if (!(await hasColabSignInModal(page))) return false;

    await this.saveAuthDomSnapshot('colab-signin-modal');
    const clicked = await clickColabSignInModal(page);
    if (!clicked.clicked) {
      await this.saveAuthDomSnapshot('colab-signin-modal-click-failed');
      return false;
    }

    await page.waitForTimeout(2000);
    this.page = await this.focusGoogleAuthPage(page);
    await this.saveAuthDomSnapshot('after-colab-signin-modal');
    return true;
  }

  private async openGoogleSignIn(page: Page): Promise<void> {
    if (await hasColabSignInModal(page)) {
      await clickColabSignInModal(page);
      this.page = await this.focusGoogleAuthPage(page);
      await page.waitForTimeout(2000);
      return;
    }

    const headerClicked = await clickByVisibleText(page, ['Sign in']);
    if (headerClicked.clicked) {
      this.page = await this.focusGoogleAuthPage(page);
      await page.waitForTimeout(2000);
    }
  }

  private async waitUntilAuthenticated(page: Page, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const context = page.context();

    while (Date.now() - start < timeoutMs) {
      if (this.awaitingTwoFactorApproval) {
        const googlePage = context.pages().find((candidate) => candidate.url().includes('accounts.google.com'));
        if (googlePage && !googlePage.isClosed()) {
          await googlePage
            .waitForURL((url) => isColabAppUrl(url.toString()), { timeout: 5000 })
            .catch(() => undefined);
        }
      }

      for (const candidate of context.pages()) {
        if (!isColabAppUrl(candidate.url())) continue;

        await candidate.waitForLoadState('domcontentloaded').catch(() => undefined);
        if (this.awaitingTwoFactorApproval) {
          await candidate.waitForLoadState('networkidle').catch(() => undefined);
          await candidate.waitForTimeout(1500);
        }

        if (await isColabAuthenticated(candidate)) {
          this.page = candidate;
          this.awaitingTwoFactorApproval = false;
          await this.persistAuthSession();
          await this.saveAuthDomSnapshot('authenticated');
          return;
        }
      }

      const pollPage = this.page ?? page;
      if (!this.awaitingTwoFactorApproval && (await hasColabSignInModal(pollPage))) {
        await this.dismissColabSignInModalIfPresent(pollPage);
        await this.resolveAuthWall(pollPage, this.lastConnectOptions);
      }

      if (this.awaitingTwoFactorApproval) {
        console.log('Waiting for phone 2FA approval...');
      }

      await pollPage.waitForTimeout(2000);
    }
    await this.saveDebugScreenshot('auth-timeout');
    throw new LoginRequiredError('Authentication timed out. Complete Google sign-in in the browser.');
  }

  private async resolveAuthWall(page: Page, options: BrowserConnectOptions): Promise<void> {
    if (await isColabAuthenticated(page)) {
      await this.persistAuthSession();
      return;
    }

    await this.dismissColabSignInModalIfPresent(page);
    await this.openGoogleSignIn(page);

    if (options.email && options.password) {
      await this.performGoogleSignIn(page, options.email, options.password);
      if (this.awaitingTwoFactorApproval) {
        console.log('2FA challenge detected — approve the sign-in on your phone...');
      }
      await this.waitUntilAuthenticated(page, options.twoFactorWaitMs ?? 300_000);
      return;
    }

    if ((await this.needsGoogleSignIn(page)) || this.isGoogleLoginPage(page.url())) {
      throw new LoginRequiredError(
        'Google sign-in required. Run client.auth.login() or pass email/password to connect().',
      );
    }
  }

  private isTwoFactorUrl(url: string): boolean {
    return (
      /challenge\/(totp|ipp|iap|skotp|dp|wa|sms|bd)/i.test(url) ||
      url.includes('twosv')
    );
  }

  private async isTwoFactorChallenge(page?: Page): Promise<boolean> {
    if (!page || page.isClosed()) return this.awaitingTwoFactorApproval;
    if (this.isTwoFactorUrl(page.url())) return true;
    return isTwoFactorChallengeVisible(page);
  }

  private async acceptMcpDialog(page: Page): Promise<void> {
    try {
      const acceptBtn = page.getByRole('button', { name: MCP_ACCEPT_BUTTON_TEXT, exact: true });
      await acceptBtn.waitFor({ timeout: PLAYWRIGHT_ACCEPT_TIMEOUT_MS, state: 'visible' });
      await acceptBtn.click();
    } catch (err) {
      await this.saveDebugScreenshot('mcp-accept-failure');
      throw new BrowserError('MCP Connect button not found', err);
    }
  }

  private async performGoogleSignIn(page: Page, email: string, password: string): Promise<void> {
    this.authStepCounter = 0;
    this.passkeyBypassAttempts = 0;
    this.choosePasswordAttempts = 0;
    this.tapYesClicked = false;
    this.awaitingTwoFactorApproval = false;

    const colabTab =
      page.context().pages().find((candidate) => isColabAppUrl(candidate.url())) ?? page;
    let activePage = await this.focusGoogleAuthPage(page);

    if (!(await isColabAuthenticated(colabTab))) {
      await this.saveAuthDomSnapshot('before-open-sign-in');
      await this.openGoogleSignIn(activePage);
      activePage = this.page ?? activePage;
      await activePage.waitForTimeout(2000);
      await this.saveAuthDomSnapshot('after-open-sign-in');
    }

    const deadline = Date.now() + 120_000;
    let idleSteps = 0;
    const maxIdleSteps = 8;

    while (Date.now() < deadline) {
      activePage = this.page ?? activePage;
      activePage = await this.focusGoogleAuthPage(activePage);

      const colabPage =
        activePage.context().pages().find((candidate) => isColabAppUrl(candidate.url())) ??
        activePage;

      if (await isColabAuthenticated(colabPage)) {
        this.page = colabPage;
        await this.saveAuthDomSnapshot('authenticated');
        return;
      }

      if (await hasColabSignInModal(colabPage)) {
        await this.dismissColabSignInModalIfPresent(colabPage);
        activePage = this.page ?? activePage;
        idleSteps = 0;
        continue;
      }

      if (!this.isGoogleLoginPage(activePage.url())) {
        if (await hasVisibleColabSignInHeader(colabPage)) {
          await this.openGoogleSignIn(colabPage);
          activePage = this.page ?? activePage;
          idleSteps = 0;
        } else {
          idleSteps += 1;
        }
        await activePage.waitForTimeout(1500);
        continue;
      }

      if (this.awaitingTwoFactorApproval) {
        await this.saveAuthDomSnapshot('two-factor-waiting');
        return;
      }

      const progressed = await this.advanceGoogleLoginStep(activePage, email, password);
      if (progressed) {
        idleSteps = 0;
      } else {
        idleSteps += 1;
        if (idleSteps >= maxIdleSteps) {
          await this.saveAuthDomSnapshot('auth-idle-stuck');
          break;
        }
        await activePage.waitForTimeout(1500);
      }
    }

    await this.saveAuthDomSnapshot('sign-in-timeout');
    throw new LoginRequiredError('Google sign-in did not complete within the time limit');
  }

  private async advanceGoogleLoginStep(page: Page, email: string, password: string): Promise<boolean> {
    await page.waitForTimeout(500);
    await this.saveAuthDomSnapshot('inspect');

    const url = page.url();

    if (await this.handleSecurityKeyChallenge(page, url)) {
      return true;
    }

    if (await this.handleTwoFactorChallenge(page)) {
      return true;
    }

    if (await this.handleChoosePasswordMethod(page)) {
      return true;
    }

    if (await this.handleAccountChooser(page, email)) {
      return true;
    }

    if (await this.handleEmailEntry(page, email)) {
      return true;
    }

    if (await this.handlePasswordEntry(page, password)) {
      return true;
    }

    if (await this.handlePostLoginPrompts(page)) {
      return true;
    }

    return false;
  }

  private async handleSecurityKeyChallenge(page: Page, url: string): Promise<boolean> {
    const onPasskeyPage =
      /challenge\/pk/i.test(url) ||
      /challenge\/sk/i.test(url) ||
      (await pageHasVisibleText(page, [
        /complete sign-in using your passkey/i,
        /use your security key/i,
        /insert your security key/i,
        /verifying it.?s you/i,
      ]));

    if (!onPasskeyPage) return false;

    await this.saveAuthDomSnapshot('security-key-detected');

    if (this.passkeyBypassAttempts >= 1) {
      return this.navigateToPasswordChallenge(page, url);
    }

    await this.saveAuthDomSnapshot('before-try-another-way');
    const clickResult = await clickByVisibleText(page, ['Try another way']);
    if (!clickResult.clicked) {
      return this.navigateToPasswordChallenge(page, url);
    }

    const changed = await waitForAuthSurfaceChange(page, url);
    await this.saveAuthDomSnapshot('after-try-another-way');

    if (!changed) {
      this.passkeyBypassAttempts += 1;
      return this.navigateToPasswordChallenge(page, url);
    }

    this.passkeyBypassAttempts = 0;
    return true;
  }

  private async navigateToPasswordChallenge(page: Page, currentUrl: string): Promise<boolean> {
    const selectionUrl = buildChallengeUrl(currentUrl, 'selection');
    const passwordUrl = buildChallengeUrl(currentUrl, 'pwd');

    for (const targetUrl of [selectionUrl, passwordUrl]) {
      if (!targetUrl || targetUrl === currentUrl) continue;
      await this.saveAuthDomSnapshot('before-challenge-url-fallback');
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PLAYWRIGHT_NAV_TIMEOUT_MS });
      await page.waitForTimeout(2000);
      await this.saveAuthDomSnapshot('after-challenge-url-fallback');
      if (page.url() !== currentUrl) {
        this.passkeyBypassAttempts = 0;
        return true;
      }
    }

    return false;
  }

  private async handleChoosePasswordMethod(page: Page): Promise<boolean> {
    const url = page.url();

    if (/challenge\/pwd/i.test(url) || (await hasPasswordInput(page))) {
      return false;
    }

    if (await isTwoFactorChallengeVisible(page)) {
      return false;
    }

    const onSelection =
      /challenge\/selection/i.test(url) ||
      (await pageHasVisibleText(page, [/choose how you want to sign in/i, /choose a way to verify/i]));

    if (!onSelection) {
      return false;
    }

    await this.saveAuthDomSnapshot('before-choose-password');

    const clickResult = await clickGoogleChallengeOption(page, 'Enter your password');
    if (!clickResult.clicked) {
      return this.navigateToPasswordChallenge(page, url);
    }

    await page.waitForTimeout(2000);
    const changed = await waitForAuthSurfaceChange(page, url);
    await this.saveAuthDomSnapshot('after-choose-password');

    if (changed || (await hasPasswordInput(page)) || /challenge\/pwd/i.test(page.url())) {
      this.choosePasswordAttempts = 0;
      return true;
    }

    this.choosePasswordAttempts += 1;
    if (this.choosePasswordAttempts >= 2) {
      return this.navigateToPasswordChallenge(page, url);
    }

    return false;
  }

  private async handleAccountChooser(page: Page, email: string): Promise<boolean> {
    const hasPasswordField = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasPasswordField) return false;

    const hasEmailField = await page
      .locator('input[type="email"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasEmailField) return false;

    const onChooser = await pageHasVisibleText(page, [
      new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      /choose an account/i,
    ]);
    if (!onChooser) return false;

    await this.saveAuthDomSnapshot('before-account-tile');
    const clicked = await clickAccountTile(page, email);
    if (!clicked) return false;
    await page.waitForTimeout(2000);
    await this.saveAuthDomSnapshot('after-account-tile');
    return true;
  }

  private async handleEmailEntry(page: Page, email: string): Promise<boolean> {
    const hasEmailField = await page
      .locator('input[type="email"], input[autocomplete="username"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (!hasEmailField) return false;

    const currentValue = await readVisibleInputValue(page, ['email']);
    if (currentValue.trim().toLowerCase() !== email.trim().toLowerCase()) {
      await this.saveAuthDomSnapshot('before-email-fill');
      await fillVisibleInput(page, email, ['email']);
      await this.saveAuthDomSnapshot('after-email-fill');
    }

    const next = await clickByVisibleText(page, ['Next']);
    if (!next.clicked) return false;

    await page.waitForTimeout(2000);
    await this.saveAuthDomSnapshot('after-email-next');
    return true;
  }

  private async handlePasswordEntry(page: Page, password: string): Promise<boolean> {
    const onPasswordChallenge =
      /challenge\/pwd/i.test(page.url()) || (await hasPasswordInput(page));
    if (!onPasswordChallenge) {
      return false;
    }

    const hasPasswordField = await hasPasswordInput(page);
    if (!hasPasswordField) {
      await page.waitForTimeout(1000);
      if (!(await hasPasswordInput(page))) return false;
    }

    await this.saveAuthDomSnapshot('before-password-fill');
    await fillVisibleInput(page, password, ['password']);
    const next = await clickByVisibleText(page, ['Next']);
    if (!next.clicked) {
      await clickByVisibleText(page, ['Sign in']);
    }
    await page.waitForTimeout(3000);
    await this.saveAuthDomSnapshot('after-password-submit');
    return true;
  }

  private async handleTwoFactorChallenge(page: Page): Promise<boolean> {
    if (!(await this.isTwoFactorChallenge(page))) {
      return false;
    }

    if (!this.tapYesClicked) {
      const onSelection = /challenge\/selection/i.test(page.url());
      const hasTapYesOption = await pageHasVisibleText(page, [/yes on your phone/i, /yes on your tablet/i]);

      if (!onSelection || !hasTapYesOption) {
        if (this.isTwoFactorUrl(page.url())) {
          this.awaitingTwoFactorApproval = true;
          console.log('Waiting for phone 2FA approval...');
          return true;
        }
        return false;
      }

      await this.saveAuthDomSnapshot('before-tap-yes');

      const tapYesLabels = [
        'Yes on your phone or tablet',
        'Tap Yes on your phone',
        'yes on your phone',
      ];
      let clicked = false;
      for (const label of tapYesLabels) {
        const result = await clickGoogleChallengeOptionPartial(page, label);
        if (result.clicked) {
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        await this.saveAuthDomSnapshot('tap-yes-click-failed');
        return false;
      }

      this.tapYesClicked = true;
      this.awaitingTwoFactorApproval = true;
      await page.waitForTimeout(2000);
      await this.saveAuthDomSnapshot('after-tap-yes-click');
      console.log('Tap Yes selected — approve the sign-in on your phone or tablet.');
      return true;
    }

    this.awaitingTwoFactorApproval = true;
    return true;
  }

  private async handlePostLoginPrompts(page: Page): Promise<boolean> {
    const labels = ['Not now', 'No thanks', 'Skip', 'Continue', 'I agree', 'Accept'];
    for (const label of labels) {
      const result = await clickByVisibleText(page, [label]);
      if (!result.clicked) continue;
      await this.saveAuthDomSnapshot('after-post-login-prompt');
      await page.waitForTimeout(2000);
      return true;
    }
    return false;
  }

  private async saveAuthDomSnapshot(step: string): Promise<void> {
    if (!this.page) return;

    try {
      await this.paths.ensureDirs();
      const authDir = join(this.paths.debugDir, 'auth');
      await mkdir(authDir, { recursive: true });

      this.authStepCounter += 1;
      const stamp = `${String(this.authStepCounter).padStart(3, '0')}-${step}`;
      const base = join(authDir, stamp);

      await writeFile(`${base}.url.txt`, this.page.url());
      await writeFile(`${base}.html`, await this.page.content());
      await this.page.screenshot({ path: `${base}.png`, fullPage: true });
      console.log(`[auth] DOM snapshot saved: ${stamp}`);
    } catch {
      // ignore snapshot failures
    }
  }

  private findColabPage(): Page | null {
    if (!this.context) return this.page;
    return this.context.pages().find((candidate) => isColabAppUrl(candidate.url())) ?? this.page;
  }

  private async ensureAuthenticatedColabPage(): Promise<void> {
    const colabPage = this.findColabPage();
    if (!colabPage) {
      throw new LoginRequiredError('Login did not reach a Colab page');
    }

    await colabPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await colabPage.waitForLoadState('networkidle').catch(() => undefined);

    if (!(await isColabAuthenticated(colabPage))) {
      throw new LoginRequiredError('Login did not complete on Colab');
    }

    this.page = colabPage;
  }

  private async persistAuthSession(): Promise<void> {
    if (!this.context) return;

    await this.paths.ensureDirs();
    await this.context.storageState({ path: join(this.paths.root, 'auth.state.json') });
  }

  private async waitForLogin(page: Page, timeoutMs: number): Promise<void> {
    await this.waitUntilAuthenticated(page, timeoutMs);
    await this.persistAuthSession();
  }

  private async saveDebugScreenshot(label: string): Promise<void> {
    if (!this.page) return;
    try {
      await this.paths.ensureDirs();
      const path = join(this.paths.debugDir, `${label}-${Date.now()}.png`);
      await this.page.screenshot({ path, fullPage: true });
      await writeFile(join(this.paths.debugDir, `${label}-url.txt`), this.page.url());
    } catch {
      // ignore screenshot failures
    }
  }
}
