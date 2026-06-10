import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ColabDevPaths } from '../src/storage/ColabDevPaths.js';

describe('ColabDevPaths', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves paths under custom root', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colabdev-'));
    const paths = new ColabDevPaths(tempDir);

    expect(paths.root).toBe(tempDir);
    expect(paths.browserProfile).toBe(join(tempDir, 'browser-profile'));
    expect(paths.settingsFile).toBe(join(tempDir, 'settings.json'));
    expect(paths.sessionFile).toBe(join(tempDir, 'session.json'));
    expect(paths.debugDir).toBe(join(tempDir, 'debug'));
  });

  it('loads empty settings when file missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colabdev-'));
    const paths = new ColabDevPaths(tempDir);
    expect(await paths.loadSettings()).toEqual({});
  });

  it('saves and loads settings', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colabdev-'));
    const paths = new ColabDevPaths(tempDir);
    await paths.saveSettings({ headless: true, keepAliveIntervalMs: 30_000 });
    const loaded = await paths.loadSettings();
    expect(loaded.headless).toBe(true);
    expect(loaded.keepAliveIntervalMs).toBe(30_000);
  });

  it('saves, loads, and clears session', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colabdev-'));
    const paths = new ColabDevPaths(tempDir);
    await paths.saveSession({ port: 1234, token: 'abc' });
    const session = await paths.loadSession();
    expect(session?.port).toBe(1234);

    await paths.clearSession();
    const raw = await readFile(paths.sessionFile, 'utf-8');
    expect(JSON.parse(raw)).toEqual({});
  });

  it('ensureDirs creates profile and debug directories', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'colabdev-'));
    const paths = new ColabDevPaths(tempDir);
    await paths.ensureDirs();
    const { stat } = await import('node:fs/promises');
    expect((await stat(paths.browserProfile)).isDirectory()).toBe(true);
    expect((await stat(paths.debugDir)).isDirectory()).toBe(true);
  });
});
