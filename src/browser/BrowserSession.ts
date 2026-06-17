import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page } from 'playwright-core';

import {
  ACCELERATOR_VALUES,
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

      // Wait for the page's auth widgets to render before checking state.
      // Without this, isColabAuthenticated() may fall through to the cookie check
      // and return true even when Colab is in guest mode.
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
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
      // Open Runtime menu and click "Change runtime type".
      // Retry up to 3 times: the item stays hidden while the runtime is in a
      // transient "Connecting…" state (common when a Drive notebook just opened).
      const MAX_MENU_ATTEMPTS = 3;
      let menuOpened = false;
      for (let attempt = 1; attempt <= MAX_MENU_ATTEMPTS; attempt++) {
        try {
          await page.locator('#runtime-menu-button').click({ timeout: RUNTIME_DIALOG_TIMEOUT_MS });
          await page.locator('[command="change-runtime-type"]').waitFor({ state: 'visible', timeout: RUNTIME_DIALOG_TIMEOUT_MS });
          await page.locator('[command="change-runtime-type"]').click();
          menuOpened = true;
          break;
        } catch (menuErr) {
          if (attempt === MAX_MENU_ATTEMPTS) throw menuErr;
          // Close menu if open, wait for runtime to settle, then retry
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(8_000);
        }
      }
      if (!menuOpened) throw new BrowserError('Could not open Change runtime type menu');

      // mwc-dialog uses shadow DOM — Playwright's visibility check fails on it,
      // and waitForFunction is blocked by Colab's CSP. Poll with evaluate instead.
      {
        const dialogDeadline = Date.now() + RUNTIME_DIALOG_TIMEOUT_MS;
        let dialogOpen = false;
        while (Date.now() < dialogDeadline) {
          dialogOpen = await page.evaluate(() => {
            const d = document.querySelector('mwc-dialog.change-runtime-type');
            return Boolean(d?.hasAttribute('open') && !d.classList.contains('colab-dialog-opening'));
          });
          if (dialogOpen) break;
          await page.waitForTimeout(300);
        }
        if (!dialogOpen) {
          throw new BrowserError('Change runtime type dialog did not open');
        }
      }
      await page.waitForTimeout(500);

      // Verified DOM structure (2026-06): colab-runtime-attributes-selector's
      // shadow root contains light-DOM children:
      //   <mwc-formfield label="T4 GPU"><mwc-radio name="accelerator" value="GPU,T4"/></mwc-formfield>
      // Click the radio by its `value` attribute; fall back to formfield label.
      const acceleratorValue = ACCELERATOR_VALUES[gpu];
      const clickRadio = () =>
        page.evaluate(
          ({ value, label }) => {
            const sel = document.querySelector('colab-runtime-attributes-selector') as any;
            const root: ShadowRoot | Document = sel?.shadowRoot ?? document;
            // Primary: exact value attribute match on mwc-radio
            let radio = root.querySelector<HTMLElement>(
              `mwc-radio[name="accelerator"][value="${value}"]`,
            );
            // Fallback: formfield label match (e.g. label="T4 GPU")
            if (!radio) {
              for (const ff of Array.from(root.querySelectorAll<HTMLElement>('mwc-formfield'))) {
                if ((ff.getAttribute('label') ?? '').toLowerCase() === label.toLowerCase()) {
                  radio = ff.querySelector<HTMLElement>('mwc-radio');
                  break;
                }
              }
            }
            if (!radio) return { clicked: false, reason: 'radio not found' };
            if (radio.hasAttribute('disabled')) return { clicked: false, reason: 'radio disabled' };
            radio.click();
            return { clicked: true, reason: '' };
          },
          { value: acceleratorValue, label: displayName },
        );

      const readChecked = () =>
        page.evaluate((value) => {
          const sel = document.querySelector('colab-runtime-attributes-selector') as any;
          const root: ShadowRoot | Document = sel?.shadowRoot ?? document;
          const radio = root.querySelector<HTMLElement>(
            `mwc-radio[name="accelerator"][value="${value}"]`,
          ) as any;
          if (!radio) return false;
          // mwc-radio exposes `checked` as a property; its shadow input mirrors it
          if (radio.checked === true || radio.hasAttribute('checked')) return true;
          const input = radio.shadowRoot?.querySelector('input[type="radio"]') as HTMLInputElement | null;
          return Boolean(input?.checked);
        }, acceleratorValue);

      let result = await clickRadio();
      if (!result.clicked) {
        throw new BrowserError(`Could not select ${displayName} radio: ${result.reason}`);
      }
      await page.waitForTimeout(400);

      // T4 and some other runtimes show a confirmation modal immediately after click
      await this.acceptRuntimeChangeConfirmation().catch(() => undefined);

      // Verify the radio actually became checked before saving; retry once
      if (!(await readChecked())) {
        result = await clickRadio();
        await page.waitForTimeout(400);
        await this.acceptRuntimeChangeConfirmation().catch(() => undefined);
        if (!(await readChecked())) {
          throw new BrowserError(`${displayName} radio did not become checked after clicking`);
        }
      }

      // Click Save — scope to the change-runtime-type dialog
      const saved = await page.evaluate(() => {
        const dialog = document.querySelector('mwc-dialog.change-runtime-type');
        const btn = dialog?.querySelector<HTMLElement>(
          'md-text-button[dialogaction="ok"], [slot="primaryAction"]',
        );
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!saved) {
        await page.getByRole('button', { name: /^Save$/i }).click({ timeout: RUNTIME_DIALOG_TIMEOUT_MS });
      }

      // "Changing runtime attributes may terminate your current session" confirm
      await this.acceptRuntimeChangeConfirmation();

      // Confirm the dialog actually closed (i.e. Save was accepted)
      {
        const closeDeadline = Date.now() + RUNTIME_DIALOG_TIMEOUT_MS;
        let closed = false;
        while (Date.now() < closeDeadline) {
          closed = await page.evaluate(
            () => !document.querySelector('mwc-dialog.change-runtime-type')?.hasAttribute('open'),
          );
          if (closed) break;
          // The confirm dialog may still be pending — try accepting again
          await this.acceptRuntimeChangeConfirmation().catch(() => undefined);
          await page.waitForTimeout(500);
        }
        if (!closed) {
          throw new BrowserError('Change runtime type dialog did not close after Save');
        }
      }
    } catch (err) {
      await this.saveDebugScreenshot('runtime-change-failure');
      throw new BrowserError(`Failed to change runtime to ${gpu}`, err);
    }
  }

  private async acceptRuntimeChangeConfirmation(): Promise<void> {
    const page = this.requirePage();
    const promptText =
      /Changing runtime attributes may terminate your current session\.\s*Are you sure you want to continue\?|Disconnect and delete runtime|switch to a T4 runtime|additional compute units/i;
    const dialog = page
      .locator(
        'mwc-dialog.yes-no-dialog[open], mwc-dialog.dismiss-runtime-warning[open], colab-dialog.yes-no-dialog, [role="alertdialog"].mdc-dialog--open',
      )
      .filter({ hasText: promptText })
      .first();

    // Poll for the confirm dialog with evaluate — waitForFunction is blocked
    // by Colab's CSP (no unsafe-eval in the main world).
    {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const present = await page
          .evaluate((source) => {
            const prompt = new RegExp(source, 'i');
            return Array.from(
              document.querySelectorAll<HTMLElement>(
                'mwc-dialog.yes-no-dialog[open], mwc-dialog.dismiss-runtime-warning[open], colab-dialog.yes-no-dialog, [role="alertdialog"].mdc-dialog--open',
              ),
            ).some((el) => prompt.test(`${el.getAttribute('aria-label') ?? ''}\n${el.innerText}`));
          }, promptText.source)
          .catch(() => false);
        if (present) break;
        await page.waitForTimeout(250);
      }
    }
    const dialogVisible = await dialog.isVisible().catch(() => false);
    const clickedByDom = await page.evaluate((source) => {
      const prompt = new RegExp(source, 'i');
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          'mwc-dialog.yes-no-dialog[open], mwc-dialog.dismiss-runtime-warning[open], colab-dialog.yes-no-dialog, [role="alertdialog"].mdc-dialog--open',
        ),
      );
      const target = dialogs.find((el) => prompt.test(`${el.getAttribute('aria-label') ?? ''}\n${el.innerText}`));
      const root = target?.closest('mwc-dialog, colab-dialog') ?? target;
      const candidates = Array.from(
        root?.querySelectorAll<HTMLElement>(
          'md-text-button[slot="primaryAction"], [slot="primaryAction"], [dialogaction="ok"], button, paper-button, [role="button"]',
        ) ?? [],
      );
      const ok = candidates.find((el) => {
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        return el.getAttribute('dialogaction') === 'ok' || text === 'ok' || el.getAttribute('slot') === 'primaryAction';
      });
      ok?.click();
      return Boolean(ok);
    }, promptText.source);

    if (clickedByDom) {
      return;
    }

    if (!dialogVisible) {
      return;
    }

    const okButton = dialog.getByRole('button', { name: /^OK$/i }).first();
    if (await okButton.isVisible().catch(() => false)) {
      await okButton.click();
      return;
    }

    const clicked = await dialog.evaluate((root) => {
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, md-text-button, paper-button, [role="button"], [dialogaction="ok"], [slot="primaryAction"]',
        ),
      );
      const ok = candidates.find((el) => (el.innerText || el.textContent || '').trim().toLowerCase() === 'ok');
      ok?.click();
      return Boolean(ok);
    });

    if (!clicked) {
      throw new BrowserError('Runtime change confirmation appeared, but no OK button was found');
    }
  }

  private async clickRuntimeMenuItem(command: string): Promise<boolean> {
    const page = this.requirePage();
    // Poll with evaluate — waitForFunction is blocked by Colab's CSP
    const deadline = Date.now() + RUNTIME_DIALOG_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ready = await page
        .evaluate((cmd) => {
          const item = document.querySelector<HTMLElement>(`.goog-menuitem[command="${cmd}"]`);
          if (!item) return false;
          const itemStyle = window.getComputedStyle(item);
          if (itemStyle.display === 'none' || itemStyle.visibility === 'hidden') return false;
          const menu = item.closest<HTMLElement>('.goog-menu');
          if (menu) {
            const menuStyle = window.getComputedStyle(menu);
            if (menuStyle.display === 'none' || menuStyle.visibility === 'hidden') return false;
          }
          return true;
        }, command)
        .catch(() => false);
      if (ready) break;
      await page.waitForTimeout(250);
    }

    return page.evaluate((cmd) => {
      const item = document.querySelector<HTMLElement>(`.goog-menuitem[command="${cmd}"]`);
      if (!item) return false;
      item.click();
      return true;
    }, command);
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
            const selectors = [
              `[data-cell-id="${id}"]`,
              `#${escaped}`,
              `#cell-${escaped}`,
              'div.cell[role="region"][aria-label^="Cell"]',
              'div.cell.notebook-cell',
              'colab-cell',
              '.cell',
            ];
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              if (el) return el;
            }
            const cells = document.querySelectorAll('colab-cell, div.cell, .cell');
            return cells.item(index) ?? null;
          };

          const tryClickRun = (root: Element | Document | ShadowRoot): boolean => {
            // 1. Try to find the actual button element first, especially in shadow roots
            const buttons = Array.from(root.querySelectorAll('button'));
            for (const btn of buttons) {
              const label = (btn.getAttribute('aria-label') || '').toLowerCase();
              const title = (btn.getAttribute('title') || '').toLowerCase();
              const id = btn.id.toLowerCase();
              if (
                id === 'run-button' ||
                label.includes('run cell') ||
                label.includes('play') ||
                title.includes('run')
              ) {
                btn.click();
                return true;
              }
            }

            // 2. Try specific custom elements that might have shadow roots we should explore
            const containers = Array.from(root.querySelectorAll('colab-run-button, .cell-execution-container'));
            for (const container of containers) {
              if (container.shadowRoot && tryClickRun(container.shadowRoot)) {
                return true;
              }
            }

            // 3. General recursion for any other shadow roots
            const all = Array.from(root.querySelectorAll('*'));
            for (const el of all) {
              if (el.shadowRoot && !containers.includes(el as any)) {
                if (tryClickRun(el.shadowRoot)) return true;
              }
            }

            // 4. Fallback to older selectors if still not found
            const legacySelectors = [
              'colab-run-button',
              '[aria-label*="Run cell" i]',
              '[aria-label*="Play" i]',
              'button[title*="Run" i]',
            ];
            for (const selector of legacySelectors) {
              const el = root.querySelector(selector);
              if (el instanceof HTMLElement) {
                el.click();
                return true;
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
    this.requirePage();
    try {
      // Colab renders interactive widget output (files.upload) inside a sandboxed
      // output iframe (outputframe.googleusercontent.com). Search all frames.
      const fileInput = await this.findFileInputAcrossFrames(cellId, cellIndex);
      if (!fileInput) {
        throw new UploadWidgetNotFoundError(cellId);
      }
      await fileInput.setInputFiles(files);
    } catch (err) {
      if (err instanceof UploadWidgetNotFoundError) throw err;
      throw new BrowserError(`Failed to set upload files on cell ${cellId}`, err);
    }
  }

  async readCellUploadState(cellId: string, cellIndex: number): Promise<CellUploadDomState> {
    const page = this.requirePage();

    // Check main frame for cell text/progress, and all frames for file input
    const mainRaw = await page.evaluate(
      ({ id, index }) => {
        const escaped = CSS.escape(id);
        const selectors = [
          `[data-cell-id="${id}"]`,
          `#cell-${escaped}`,
          `#${escaped}`,
          'div.cell[role="region"][aria-label^="Cell"]',
          'div.cell.notebook-cell',
          'colab-cell',
          '.cell',
        ];
        const findCell = (): Element | null => {
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) return el;
          }
          return document.querySelectorAll('colab-cell, div.cell, .cell').item(index) ?? null;
        };

        const cell = findCell();
        if (!cell) return { textContent: '', progressValue: undefined as number | undefined, progressMax: undefined as number | undefined };
        const textContent = (cell as HTMLElement).innerText ?? '';
        const progress = cell.querySelector('progress');
        return {
          textContent,
          progressValue: progress ? progress.value : undefined,
          progressMax: progress ? progress.max : undefined,
        };
      },
      { id: cellId, index: cellIndex },
    );

    // Search all frames (including output iframes) for file inputs and upload text.
    // The Colab files.upload() widget renders inside a sandboxed cross-origin
    // outputframe.googleusercontent.com iframe — so progress/done text and the
    // file input itself are only accessible via frame iteration.
    let fileInputCount = 0;
    let iframeText = '';
    let iframeProgressValue: number | undefined;
    let iframeProgressMax: number | undefined;
    for (const frame of page.frames()) {
      try {
        const frameData = await frame.evaluate(() => {
          const inputCount = document.querySelectorAll('input[type="file"]').length;
          const text = document.body?.innerText ?? '';
          const progress = document.querySelector('progress');
          return {
            inputCount,
            text,
            progressValue: progress ? (progress as HTMLProgressElement).value : undefined,
            progressMax: progress ? (progress as HTMLProgressElement).max : undefined,
          };
        });
        fileInputCount += frameData.inputCount;
        if (frameData.text.trim()) {
          iframeText += '\n' + frameData.text;
        }
        if (iframeProgressValue === undefined && frameData.progressValue !== undefined) {
          iframeProgressValue = frameData.progressValue;
          iframeProgressMax = frameData.progressMax;
        }
      } catch {
        // cross-origin or detached frames; skip
      }
    }

    const combinedText = [mainRaw.textContent, iframeText].filter(Boolean).join('\n');
    const progressValue = mainRaw.progressValue ?? iframeProgressValue;
    const progressMax = mainRaw.progressMax ?? iframeProgressMax;

    return mergeUploadDomState({
      hasFileInput: fileInputCount > 0,
      fileInputCount,
      textContent: combinedText,
      progressValue,
      progressMax,
    });
  }

  private async findFileInputAcrossFrames(
    cellId: string,
    cellIndex: number,
  ): Promise<import('playwright-core').ElementHandle<HTMLInputElement> | null> {
    const page = this.requirePage();
    for (const frame of page.frames()) {
      try {
        const handle = await frame.evaluateHandle(
          () => document.querySelector('input[type="file"]') as HTMLInputElement | null,
        );
        const el = handle.asElement() as import('playwright-core').ElementHandle<HTMLInputElement> | null;
        if (el) return el;
        await handle.dispose();
      } catch {
        // cross-origin or detached frames; skip
      }
    }
    // Fallback: try main frame with cell-scoped DOM search (shadow roots)
    const handle = await page.evaluateHandle(
      ({ id, index }) => {
        const escaped = CSS.escape(id);
        const selectors = [
          `[data-cell-id="${id}"]`,
          `#cell-${escaped}`,
          `#${escaped}`,
          'div.cell.notebook-cell',
          '.cell',
        ];
        const findCell = (): Element | null => {
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) return el;
          }
          return document.querySelectorAll('colab-cell, div.cell, .cell').item(index) ?? null;
        };
        const collectInputs = (root: Element | Document | ShadowRoot): HTMLInputElement[] => {
          const inputs: HTMLInputElement[] = Array.from(root.querySelectorAll('input[type="file"]'));
          root.querySelectorAll('*').forEach((el) => {
            if (el.shadowRoot) inputs.push(...collectInputs(el.shadowRoot));
          });
          return inputs;
        };
        const cell = findCell();
        return cell ? (collectInputs(cell)[0] ?? null) : null;
      },
      { id: cellId, index: cellIndex },
    );
    const el = handle.asElement() as import('playwright-core').ElementHandle<HTMLInputElement> | null;
    if (!el) await handle.dispose();
    return el;
  }

  async stopRuntime(): Promise<void> {
    const page = this.requirePage();
    try {
      await page.getByText('Runtime', { exact: true }).first().click();
      if (await this.clickRuntimeMenuItem('powerwash-current-vm')) {
        const confirm = page.getByRole('button', { name: /OK|Yes|Disconnect/i });
        if (await confirm.count()) {
          await confirm.first().click();
        } else {
          await this.acceptRuntimeChangeConfirmation().catch(() => undefined);
        }
      }
    } catch (err) {
      throw new BrowserError('Failed to stop runtime', err);
    }
  }

  // ── Session management (Runtime > Manage sessions) ────────────────────────
  // DOM (verified 2026-06): mwc-dialog#sessions-dialog[open] holds
  // <colab-sessions-dialog> with <colab-session class="dialog-table-row">
  // rows ([iscurrentsession] marks ours). Each row's shadow root has
  // .session-title / .last-date-column / .ram-usage and an
  // md-icon-button[data-aria-label="Terminate <title>"]. Footer has
  // md-text-button.terminate-others and md-text-button[dialogaction="cancel"].

  async listSessions(): Promise<import('../types/index.js').ColabSessionInfo[]> {
    try {
      await this.openSessionsDialog();
      const sessions = await this.readSessionRows();
      await this.closeSessionsDialog();
      return sessions;
    } catch (err) {
      await this.saveDebugScreenshot('list-sessions-failure');
      throw new BrowserError('Failed to list Colab sessions', err);
    }
  }

  /** Terminate a single session by its dialog title. Returns false if not found. */
  async terminateSession(title: string): Promise<boolean> {
    const page = this.requirePage();
    try {
      await this.openSessionsDialog();
      const clicked = await page.evaluate((t) => {
        const buttons: HTMLElement[] = [];
        const walk = (root: Document | ShadowRoot | Element, depth: number) => {
          if (depth > 10) return;
          for (const el of Array.from(root.querySelectorAll<HTMLElement>('md-icon-button[data-aria-label]'))) {
            buttons.push(el);
          }
          for (const el of Array.from(root.querySelectorAll('*'))) {
            if ((el as any).shadowRoot) walk((el as any).shadowRoot, depth + 1);
          }
        };
        walk(document, 0);
        const target = buttons.find(
          (b) => (b.getAttribute('data-aria-label') ?? '') === `Terminate ${t}`,
        );
        if (!target) return false;
        target.click();
        return true;
      }, title);

      if (clicked) {
        await this.confirmTerminateDialog();
        await page.waitForTimeout(1500);
      }
      await this.closeSessionsDialog();
      return clicked;
    } catch (err) {
      await this.saveDebugScreenshot('terminate-session-failure');
      throw new BrowserError(`Failed to terminate session "${title}"`, err);
    }
  }

  /**
   * Terminate every session except the current one via the dialog's
   * "Terminate other sessions" button. Returns how many sessions were closed.
   */
  async terminateOtherSessions(): Promise<number> {
    const page = this.requirePage();
    try {
      await this.openSessionsDialog();
      const before = await this.readSessionRows();
      const others = before.filter((s) => !s.isCurrent).length;
      if (others === 0) {
        await this.closeSessionsDialog();
        return 0;
      }

      const clicked = await page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>(
          'mwc-dialog#sessions-dialog md-text-button.terminate-others',
        );
        if (!btn || btn.hasAttribute('disabled')) return false;
        btn.click();
        return true;
      });

      if (!clicked) {
        // Button disabled/missing — fall back to terminating rows one by one
        for (const session of before.filter((s) => !s.isCurrent)) {
          await page.evaluate((t) => {
            const buttons: HTMLElement[] = [];
            const walk = (root: Document | ShadowRoot | Element, depth: number) => {
              if (depth > 10) return;
              for (const el of Array.from(root.querySelectorAll<HTMLElement>('md-icon-button[data-aria-label]'))) {
                buttons.push(el);
              }
              for (const el of Array.from(root.querySelectorAll('*'))) {
                if ((el as any).shadowRoot) walk((el as any).shadowRoot, depth + 1);
              }
            };
            walk(document, 0);
            buttons.find((b) => (b.getAttribute('data-aria-label') ?? '') === `Terminate ${t}`)?.click();
          }, session.title);
          await this.confirmTerminateDialog();
          await page.waitForTimeout(1000);
        }
      } else {
        await this.confirmTerminateDialog();
      }

      // Wait for the other rows to disappear
      const deadline = Date.now() + 30_000;
      while (Date.now() - deadline < 0) {
        const rows = await this.readSessionRows();
        if (rows.filter((s) => !s.isCurrent).length === 0) break;
        await page.waitForTimeout(1000);
      }

      await this.closeSessionsDialog();
      return others;
    } catch (err) {
      await this.saveDebugScreenshot('terminate-others-failure');
      throw new BrowserError('Failed to terminate other sessions', err);
    }
  }

  private async openSessionsDialog(): Promise<void> {
    const page = this.requirePage();
    const isOpen = () =>
      page.evaluate(() =>
        Boolean(document.querySelector('mwc-dialog#sessions-dialog')?.hasAttribute('open')),
      );

    if (await isOpen()) return;

    await page.locator('#runtime-menu-button').click({ timeout: RUNTIME_DIALOG_TIMEOUT_MS });
    // goog.ui menu items ignore synthetic element.click() — use a real
    // Playwright mouse click (same as selectRuntime does)
    await page
      .locator('[command="manage-sessions"]')
      .waitFor({ state: 'visible', timeout: RUNTIME_DIALOG_TIMEOUT_MS });
    await page.locator('[command="manage-sessions"]').click();

    const deadline = Date.now() + RUNTIME_DIALOG_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isOpen()) {
        // give the session list a moment to populate
        await page.waitForTimeout(1000);
        return;
      }
      await page.waitForTimeout(250);
    }
    throw new BrowserError('Sessions dialog did not open');
  }

  private async closeSessionsDialog(): Promise<void> {
    const page = this.requirePage();
    await page.evaluate(() => {
      const dialog = document.querySelector('mwc-dialog#sessions-dialog');
      dialog?.querySelector<HTMLElement>('md-text-button[dialogaction="cancel"]')?.click();
    });
    await page.waitForTimeout(500);
  }

  private async readSessionRows(): Promise<import('../types/index.js').ColabSessionInfo[]> {
    const page = this.requirePage();
    return page.evaluate(() => {
      const rows = new Set<Element>();
      const walk = (root: Document | ShadowRoot | Element, depth: number) => {
        if (depth > 10) return;
        for (const el of Array.from(root.querySelectorAll('colab-session'))) rows.add(el);
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if ((el as any).shadowRoot) walk((el as any).shadowRoot, depth + 1);
        }
      };
      walk(document, 0);

      return Array.from(rows).map((row) => {
        const sr = (row as any).shadowRoot as ShadowRoot | null;
        const read = (selector: string): string => {
          const el =
            sr?.querySelector<HTMLElement>(selector) ?? row.querySelector<HTMLElement>(selector);
          return (el?.innerText ?? '').trim();
        };
        return {
          title: read('.session-title'),
          isCurrent: row.hasAttribute('iscurrentsession'),
          lastExecution: read('.last-date-column'),
          ramUsed: read('.ram-usage'),
        };
      });
    });
  }

  /** Accept a "terminate session?" yes-no confirm if Colab shows one. */
  private async confirmTerminateDialog(): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const clicked = await page
        .evaluate(() => {
          for (const d of Array.from(
            document.querySelectorAll<HTMLElement>('mwc-dialog[open]'),
          )) {
            if (d.id === 'sessions-dialog') continue;
            if (!/terminate/i.test(d.innerText ?? '')) continue;
            const ok = d.querySelector<HTMLElement>(
              '[dialogaction="ok"], [slot="primaryAction"]',
            );
            if (ok) {
              ok.click();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      if (clicked) return;
      await page.waitForTimeout(300);
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

    const dismissGpuQuotaDialog = async (): Promise<boolean> => {
      const noGpuText = /cannot connect to (gpu|tpu) backend|usage limits in colab/i;
      const dialogVisible = await page.getByText(noGpuText).count().then((n) => n > 0).catch(() => false);
      if (!dialogVisible) return false;
      // Click "Connect without GPU" to fall back to CPU runtime
      const fallbackBtn = page.getByRole('button', { name: /connect without (gpu|tpu)/i });
      if (await fallbackBtn.count()) {
        await fallbackBtn.first().click({ timeout: 3000 }).catch(() => {});
        return true;
      }
      return false;
    };

    const start = Date.now();
    let connectingStartMs: number | null = null; // track how long we've been "Connecting"

    // Force-terminate a stuck "Resuming execution" / perpetually Connecting session
    // via Runtime > Disconnect and delete runtime, then re-click Connect.
    const forceDisconnectRuntime = async (): Promise<boolean> => {
      try {
        await page.getByText('Runtime', { exact: true }).first().click({ timeout: 3000 });
        await page.waitForTimeout(600);
        // look for "Disconnect and delete runtime" or "Terminate session" items
        const discItem = page.getByText(/disconnect and delete runtime|terminate session/i).first();
        if ((await discItem.count()) === 0) {
          await page.keyboard.press('Escape');
          return false;
        }
        await discItem.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        // Confirm dialog (OK / Yes)
        await page.getByRole('button', { name: /^(OK|Yes|Disconnect)$/i }).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(2000);
        connectingStartMs = null;
        return true;
      } catch {
        await page.keyboard.press('Escape').catch(() => {});
        return false;
      }
    };

    while (Date.now() - start < timeoutMs) {
      if (await hasColabSignInModal(page)) {
        await this.dismissColabSignInModalIfPresent(page);
        await this.resolveAuthWall(page, this.lastConnectOptions);
        await page.waitForTimeout(2000);
        continue;
      }

      // If GPU quota dialog is showing, click "Connect without GPU" and wait
      if (await dismissGpuQuotaDialog()) {
        await page.waitForTimeout(3000);
        connectingStartMs = null;
        continue;
      }

      // Concurrent-session limit ("Too many sessions") — close the dialog and
      // free up a slot by terminating other sessions, then retry connecting.
      const sessionLimitHit = await page
        .evaluate(() => {
          for (const d of Array.from(document.querySelectorAll<HTMLElement>('mwc-dialog[open]'))) {
            if (/too many (active )?sessions|maximum number of sessions/i.test(d.innerText ?? '')) {
              const close = d.querySelector<HTMLElement>(
                '[dialogaction="cancel"], [dialogaction="ok"], [slot="primaryAction"]',
              );
              close?.click();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      if (sessionLimitHit) {
        await page.waitForTimeout(1000);
        await this.terminateOtherSessions().catch(() => 0);
        connectingStartMs = null;
        await page.waitForTimeout(2000);
        continue;
      }

      // Get the current connect button label to decide what to do
      const btnText = await page.evaluate(() => {
        const cb = document.querySelector('colab-connect-button') as any;
        const sr = cb?.shadowRoot;
        const btn = sr?.querySelector('#connect');
        return ((btn as HTMLElement | null)?.innerText ?? '').trim();
      }).catch(() => '');

      // Already connecting — just wait; don't interrupt by clicking again
      if (/^connecting$/i.test(btnText)) {
        if (connectingStartMs === null) connectingStartMs = Date.now();
        // If stuck "Connecting" for > 40s, the session is likely dead —
        // force-terminate via Runtime > Disconnect and delete runtime
        if (Date.now() - connectingStartMs > 40_000) {
          await forceDisconnectRuntime();
        }
        await page.waitForTimeout(3000);
        continue;
      }

      connectingStartMs = null;

      // Connected: button text is empty (resource bars show) and not allocating
      if (btnText === '') {
        const allocating = page.getByText(/Allocating runtime/i);
        if ((await allocating.count()) === 0) {
          await page.waitForTimeout(2000);
          return;
        }
        // allocating in progress — wait
        await page.waitForTimeout(3000);
        continue;
      }

      // Needs a click: "Connect", "Reconnect", "Connect T4 GPU", etc.
      await clickRuntimeConnect();

      // Check for GPU quota dialog triggered by the connect click
      if (await dismissGpuQuotaDialog()) {
        await page.waitForTimeout(3000);
        connectingStartMs = null;
        continue;
      }

      await page.waitForTimeout(3000);
    }

    await this.saveDebugScreenshot('runtime-connect-timeout');
    throw new BrowserError('Timed out waiting for Colab runtime to connect');
  }

  /** Walk every text node in the page (including shadow DOM) and return concatenated content. */
  async readPageText(): Promise<string> {
    if (!this.page) return '';
    try {
      return await this.page.evaluate((): string => {
        const parts: string[] = [];
        const walk = (root: Node): void => {
          if (root.nodeType === 3) {
            const v = (root as Text).nodeValue;
            if (v) parts.push(v);
            return;
          }
          for (const child of Array.from(root.childNodes)) walk(child);
          const sr = (root as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) walk(sr);
        };
        walk(document);
        return parts.join('');
      });
    } catch {
      return '';
    }
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

        if (this.awaitingTwoFactorApproval && !(await hasColabSignInWall(candidate))) {
          this.page = candidate;
          this.awaitingTwoFactorApproval = false;
          await this.persistAuthSession();
          await this.saveAuthDomSnapshot('authenticated-colab-redirect');
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
      if ((await isColabAppUrl(colabPage.url())) && !(await hasColabSignInWall(colabPage))) {
        this.page = colabPage;
        this.awaitingTwoFactorApproval = false;
        await this.persistAuthSession();
        await this.saveAuthDomSnapshot('authenticated-colab-redirect');
        return;
      }

      throw new LoginRequiredError('Login did not complete on Colab');
    }

    this.page = colabPage;
    this.awaitingTwoFactorApproval = false;
    await this.persistAuthSession();
    await this.saveAuthDomSnapshot('authenticated');
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
