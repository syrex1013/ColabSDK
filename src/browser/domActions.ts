import type { BrowserContext, Page } from 'playwright-core';

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isColabAppUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'colab.research.google.com';
  } catch {
    return false;
  }
}

export interface DomClickResult {
  clicked: boolean;
  matchedText?: string;
  tag?: string;
}

function isPageUsable(page: Page): boolean {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

export async function pageHasVisibleText(page: Page, patterns: RegExp[]): Promise<boolean> {
  if (!isPageUsable(page)) return false;
  return page.evaluate((patternSources) => {
    const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
    return patternSources.some(([source, flags]) => new RegExp(source, flags).test(bodyText));
  }, patterns.map((pattern) => [pattern.source, pattern.flags] as [string, string]));
}

export async function clickByVisibleText(
  page: Page,
  labels: string[],
  options: { exact?: boolean; partial?: boolean; rootSelector?: string } = {},
): Promise<DomClickResult> {
  return page.evaluate(
    ({ labelList, exact, partial, rootSelector }) => {
      const targets = labelList.map((label) => label.replace(/\s+/g, ' ').trim().toLowerCase());
      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const textOf = (el: Element): string =>
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

      const ariaOf = (el: Element): string =>
        (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

      const root = rootSelector ? document.querySelector(rootSelector) : document;
      if (!root) return { clicked: false };

      const candidates = Array.from(
        root.querySelectorAll(
          'button, a, md-text-button, [role="button"], [role="link"], input[type="submit"], div[tabindex], li',
        ),
      );

      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = textOf(el);
        const aria = ariaOf(el);
        for (const target of targets) {
          const textMatch = exact ? text === target : partial ? text.includes(target) : text === target;
          const ariaMatch = exact ? aria === target : partial ? aria.includes(target) : aria === target;
          if (textMatch || ariaMatch) {
            (el as HTMLElement).click();
            return { clicked: true, matchedText: text || aria, tag: el.tagName.toLowerCase() };
          }
        }
      }

      return { clicked: false };
    },
    {
      labelList: labels,
      exact: options.exact ?? true,
      partial: options.partial ?? false,
      rootSelector: options.rootSelector ?? null,
    },
  );
}

export async function fillVisibleInput(
  page: Page,
  value: string,
  kinds: Array<'email' | 'password' | 'text'>,
): Promise<boolean> {
  const selectors: string[] = [];
  if (kinds.includes('email')) {
    selectors.push(
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[name="identifier"]',
      'input[inputmode="email"]',
    );
  }
  if (kinds.includes('password')) {
    selectors.push('input[type="password"]', 'input[name="Passwd"]', 'input[autocomplete="current-password"]');
  }
  if (kinds.includes('text')) {
    selectors.push('input[type="text"]');
  }

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(value);
    return true;
  }

  return false;
}

export async function readVisibleInputValue(page: Page, kinds: Array<'email' | 'password'>): Promise<string> {
  return page.evaluate((inputKinds) => {
    const selectors: string[] = [];
    if (inputKinds.includes('email')) {
      selectors.push(
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[name="identifier"]',
        'input[inputmode="email"]',
      );
    }
    if (inputKinds.includes('password')) {
      selectors.push('input[type="password"]', 'input[name="Passwd"]');
    }

    for (const selector of selectors) {
      const el = document.querySelector(selector) as HTMLInputElement | null;
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      return el.value ?? '';
    }
    return '';
  }, kinds);
}

export async function clickAccountTile(page: Page, email: string): Promise<boolean> {
  return page.evaluate((accountEmail) => {
    const target = accountEmail.trim().toLowerCase();
    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const candidates = Array.from(
      document.querySelectorAll('button, li, div[role="link"], a, [role="button"], [role="option"]'),
    );

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.includes(target)) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, email);
}

export async function waitForAuthSurfaceChange(
  page: Page,
  previousUrl: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const previousBody = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim());
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (url !== previousUrl) return true;

    const bodyNow = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim());
    if (bodyNow !== previousBody) {
      const movedPastPasskey =
        /enter your password/i.test(bodyNow) ||
        /choose how you want to sign in/i.test(bodyNow) ||
        /choose a way to verify/i.test(bodyNow) ||
        !/complete sign-in using your passkey/i.test(bodyNow);
      if (movedPastPasskey) return true;
    }

    if (/\/challenge\/pwd/i.test(url)) return true;

    const hasPasswordField = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasPasswordField) return true;

    await page.waitForTimeout(300);
  }
  return false;
}

export function buildChallengeUrl(currentUrl: string, challenge: 'pwd' | 'selection'): string | null {
  if (!currentUrl.includes('/challenge/')) return null;
  return currentUrl.replace(/\/challenge\/[^/?#]+/, `/challenge/${challenge}`);
}

export function labelsMatch(text: string, labels: string[]): boolean {
  const normalized = normalizeText(text);
  return labels.some((label) => normalizeText(label) === normalized);
}

export async function hasColabSignInModal(page: Page): Promise<boolean> {
  const playwrightDialog = page.getByRole('alertdialog', { name: /google sign-in required/i });
  if ((await playwrightDialog.count()) > 0) {
    return playwrightDialog.first().isVisible().catch(() => false);
  }

  const mwcDialog = page.locator(
    'mwc-dialog.yes-no-dialog[open]:not([inert]):not([aria-hidden="true"])',
  );
  if ((await mwcDialog.count()) > 0) {
    const text = await mwcDialog.first().innerText().catch(() => '');
    if (/logged in with a google account|google sign-in required/i.test(text)) {
      return true;
    }
  }

  return page.evaluate(() => {
    const isVisibleEl = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOfEl = (el: Element): string =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isOpenDialog = (el: Element): boolean => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.hasAttribute('inert')) return false;
      if (!isVisibleEl(el)) return false;
      if (el.hasAttribute('open')) return true;
      return el.classList.contains('mdc-dialog--open');
    };
    const dialogRequiresSignIn = (dialog: Element): boolean => {
      const aria = (dialog.getAttribute('aria-label') ?? '').toLowerCase();
      const text = textOfEl(dialog);
      return (
        aria.includes('google sign-in required') ||
        text.includes('google sign-in required') ||
        text.includes('you must be logged in with a google account')
      );
    };

    const dialogs = Array.from(
      document.querySelectorAll('mwc-dialog, [role="alertdialog"], .mdc-dialog--open'),
    );
    return dialogs.some((dialog) => isOpenDialog(dialog) && dialogRequiresSignIn(dialog));
  });
}

export async function isTwoFactorChallengeVisible(page: Page): Promise<boolean> {
  if (!isPageUsable(page)) return false;
  if (!page.url().includes('accounts.google.com')) return false;

  return pageHasVisibleText(page, [
    /2-step verification/i,
    /get a verification code/i,
    /google authenticator/i,
    /tap\s+yes\s+on your phone/i,
    /check your (phone|device)/i,
    /sent a notification/i,
  ]);
}

export async function clickGoogleChallengeOptionPartial(page: Page, textNeedle: string): Promise<DomClickResult> {
  const pattern = new RegExp(textNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const link = page.getByRole('link', { name: pattern });
  if ((await link.count()) > 0) {
    await link.first().click();
    return { clicked: true, matchedText: textNeedle, tag: 'role-link-partial' };
  }

  const locator = page.locator('[role="link"], li, div[tabindex="0"]').filter({ hasText: pattern });
  if ((await locator.count()) > 0) {
    await locator.first().click();
    return { clicked: true, matchedText: textNeedle, tag: 'filtered-link-partial' };
  }

  return page.evaluate((needle) => {
    const isVisibleEl = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOfEl = (el: Element): string =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = needle.toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll('[role="link"], li, div[tabindex="0"], [data-action="selectchallenge"]'),
    );

    for (const el of candidates) {
      if (!isVisibleEl(el)) continue;
      const text = textOfEl(el);
      if (text.includes(target)) {
        (el as HTMLElement).click();
        return { clicked: true, matchedText: text, tag: el.getAttribute('role') ?? el.tagName.toLowerCase() };
      }
    }

    return { clicked: false };
  }, textNeedle);
}

export async function clickGoogleChallengeOption(page: Page, label: string): Promise<DomClickResult> {
  const link = page.getByRole('link', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  if ((await link.count()) > 0) {
    await link.first().click();
    return { clicked: true, matchedText: label, tag: 'role-link' };
  }

  const locator = page.locator('[role="link"], li, div[tabindex="0"]').filter({
    hasText: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  });
  if ((await locator.count()) > 0) {
    await locator.first().click();
    return { clicked: true, matchedText: label, tag: 'filtered-link' };
  }

  return page.evaluate((targetLabel) => {
    const isVisibleEl = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOfEl = (el: Element): string =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = targetLabel.toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll('[role="link"], li, div[tabindex="0"], [data-action="selectchallenge"]'),
    );

    for (const el of candidates) {
      if (!isVisibleEl(el)) continue;
      const text = textOfEl(el);
      if (text === target || (text.includes(target) && text.length < target.length + 20)) {
        (el as HTMLElement).click();
        return { clicked: true, matchedText: text, tag: el.getAttribute('role') ?? el.tagName.toLowerCase() };
      }
    }

    return { clicked: false };
  }, label);
}

export async function hasVisibleColabSignInHeader(page: Page): Promise<boolean> {
  const signInLink = page.locator(
    'a[aria-label="Sign in"][href*="accounts.google.com"], a.gb_0a[href*="ServiceLogin"]',
  );
  if ((await signInLink.count()) > 0) {
    const visible = await signInLink.first().isVisible().catch(() => false);
    if (visible) return true;
  }

  // Broader fallback: any visible "Sign in" element outside a dialog/modal.
  // Catches the current Colab guest-mode sign-in button regardless of DOM structure.
  return page.evaluate(() => {
    const isVisibleOutsideDialog = (el: Element): boolean => {
      if (el.closest('[role="dialog"], [role="alertdialog"], mwc-dialog, .mdc-dialog')) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('a, button, [role="button"], md-text-button'),
    )) {
      if (!isVisibleOutsideDialog(el)) continue;
      const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
      if (text === 'Sign in' || aria === 'Sign in') return true;
    }
    return false;
  });
}

export async function isGoogleAuthInProgress(page: Page): Promise<boolean> {
  if (page.url().includes('accounts.google.com')) return true;

  const hasChallengeText = await pageHasVisibleText(page, [
    /choose how you want to sign in/i,
    /complete sign-in using your passkey/i,
    /verifying it.?s you/i,
    /sign in - google accounts/i,
  ]);
  if (!hasChallengeText) return false;

  const hasEmailField = await page
    .locator('input[type="email"], input[name="identifier"]')
    .first()
    .isVisible()
    .catch(() => false);
  const hasPasswordField = await hasPasswordInput(page);
  return hasEmailField || hasPasswordField;
}

export async function hasColabLoggedInIndicator(page: Page): Promise<boolean> {
  if (!isPageUsable(page)) return false;
  if (!isColabAppUrl(page.url())) return false;
  if (await hasVisibleColabSignInHeader(page)) return false;

  const accountLink = page.locator(
    'a[aria-label*="Google Account"], a[href*="SignOutOptions"], img.gb_Q, a.gb_Aa',
  );
  if ((await accountLink.count()) > 0) {
    return accountLink.first().isVisible().catch(() => false);
  }

  return page.evaluate(() => {
    const profileSelectors = [
      'a[aria-label*="Google Account"]',
      'a[href*="SignOutOptions"]',
      'img.gb_Q',
      'a.gb_Aa',
    ];

    for (const selector of profileSelectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }

    return false;
  });
}

const GOOGLE_SESSION_COOKIES = new Set(['SID', 'SSID', 'HSID', 'APISID', 'SAPISID']);

export async function hasGoogleAuthCookies(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies();

  return cookies.some(
    (cookie) =>
      cookie.domain.includes('google.com') &&
      cookie.value.length > 0 &&
      (GOOGLE_SESSION_COOKIES.has(cookie.name) || cookie.name.startsWith('__Secure-1PSID')),
  );
}

export async function hasColabSignInWall(page: Page): Promise<boolean> {
  if (!isPageUsable(page)) return false;
  if (!isColabAppUrl(page.url())) return false;
  if (await hasColabSignInModal(page)) return true;
  if (await hasVisibleColabSignInHeader(page)) return true;

  return pageHasVisibleText(page, [
    /you must be logged in with a google account/i,
    /google sign-in required/i,
  ]);
}

export async function isColabAuthenticated(page: Page): Promise<boolean> {
  try {
    if (!isPageUsable(page)) return false;
    if (!isColabAppUrl(page.url())) return false;
    if (await hasColabSignInWall(page)) return false;
    if (await hasColabLoggedInIndicator(page)) return true;

    return hasGoogleAuthCookies(page.context());
  } catch {
    return false;
  }
}

export async function hasPasswordInput(page: Page): Promise<boolean> {
  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

export async function clickColabSignInModal(page: Page): Promise<DomClickResult> {
  const mwcPrimary = page.locator(
    'mwc-dialog.yes-no-dialog[open]:not([inert]):not([aria-hidden="true"]) md-text-button[slot="primaryAction"]',
  );
  if ((await mwcPrimary.count()) > 0) {
    await mwcPrimary.first().click();
    return { clicked: true, matchedText: 'Sign in', tag: 'mwc-primary-action' };
  }

  const alertDialog = page.getByRole('alertdialog', { name: /google sign-in required/i });
  if ((await alertDialog.count()) > 0) {
    const inDialog = alertDialog.getByRole('button', { name: /^Sign in$/i });
    if ((await inDialog.count()) > 0) {
      await inDialog.first().click();
      return { clicked: true, matchedText: 'Sign in', tag: 'alertdialog-button' };
    }
  }

  const scoped = await clickByVisibleText(page, ['Sign in'], {
    rootSelector: 'mwc-dialog.yes-no-dialog[open]:not([inert]):not([aria-hidden="true"])',
  });
  if (scoped.clicked) return scoped;

  return page.evaluate(() => {
    const isVisibleEl = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOfEl = (el: Element): string =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isOpenDialog = (el: Element): boolean => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.hasAttribute('inert')) return false;
      if (!isVisibleEl(el)) return false;
      if (el.hasAttribute('open')) return true;
      return el.classList.contains('mdc-dialog--open');
    };
    const dialogRequiresSignIn = (dialog: Element): boolean => {
      const aria = (dialog.getAttribute('aria-label') ?? '').toLowerCase();
      const text = textOfEl(dialog);
      return (
        aria.includes('google sign-in required') ||
        text.includes('google sign-in required') ||
        text.includes('you must be logged in with a google account')
      );
    };

    const dialogs = Array.from(
      document.querySelectorAll('mwc-dialog, [role="alertdialog"], .mdc-dialog--open[aria-modal="true"]'),
    ).filter((dialog) => isOpenDialog(dialog) && dialogRequiresSignIn(dialog));

    for (const dialog of dialogs) {
      const primary = dialog.querySelector(
        'md-text-button[slot="primaryAction"], [slot="primaryAction"], [dialogaction="ok"]',
      );
      if (primary && isVisibleEl(primary)) {
        (primary as HTMLElement).click();
        return { clicked: true, matchedText: 'sign in', tag: 'dialog-primary-action' };
      }

      const buttons = Array.from(
        dialog.querySelectorAll('button, md-text-button, [role="button"], a, [role="link"]'),
      );
      for (const btn of buttons) {
        if (!isVisibleEl(btn)) continue;
        if (textOfEl(btn) === 'sign in') {
          (btn as HTMLElement).click();
          return { clicked: true, matchedText: 'sign in', tag: 'dialog-descendant' };
        }
      }
    }

    return { clicked: false };
  });
}
