import { describe, expect, it, vi } from 'vitest';

import {
  buildChallengeUrl,
  isColabAppUrl,
  labelsMatch,
  pageHasVisibleText,
} from '../src/browser/domActions.js';

describe('domActions', () => {
  it('detects Colab app URLs by hostname only', () => {
    expect(isColabAppUrl('https://colab.research.google.com/notebooks/empty.ipynb')).toBe(true);
    expect(
      isColabAppUrl(
        'https://accounts.google.com/signin?continue=https%3A%2F%2Fcolab.research.google.com',
      ),
    ).toBe(false);
    expect(isColabAppUrl('not-a-url')).toBe(false);
  });

  it('builds challenge URLs', () => {
    const url = 'https://accounts.google.com/v3/signin/challenge/pk?flow=1';
    expect(buildChallengeUrl(url, 'pwd')).toBe(
      'https://accounts.google.com/v3/signin/challenge/pwd?flow=1',
    );
    expect(buildChallengeUrl('https://example.com/login', 'pwd')).toBeNull();
  });

  it('matches labels case-insensitively', () => {
    expect(labelsMatch('Enter Your Password', ['enter your password'])).toBe(true);
    expect(labelsMatch('Other', ['enter your password'])).toBe(false);
  });

  it('pageHasVisibleText delegates to page.evaluate', async () => {
    const page = {
      isClosed: () => false,
      evaluate: vi.fn().mockResolvedValue(true),
    };
    const result = await pageHasVisibleText(page as never, [/sign in/i]);
    expect(result).toBe(true);
    expect(page.evaluate).toHaveBeenCalled();
  });

  it('pageHasVisibleText returns false for closed pages', async () => {
    const page = {
      isClosed: () => true,
      evaluate: vi.fn(),
    };
    expect(await pageHasVisibleText(page as never, [/sign in/i])).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
