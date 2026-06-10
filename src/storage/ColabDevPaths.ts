import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ColabSettings } from '../types/index.js';

const DEFAULT_DIR = '.colabdev';

export class ColabDevPaths {
  readonly root: string;
  readonly browserProfile: string;
  readonly settingsFile: string;
  readonly sessionFile: string;
  readonly debugDir: string;

  constructor(rootDir?: string) {
    this.root = rootDir ?? join(process.cwd(), process.env.COLABDEV_DIR ?? DEFAULT_DIR);
    this.browserProfile = join(this.root, 'browser-profile');
    this.settingsFile = join(this.root, 'settings.json');
    this.sessionFile = join(this.root, 'session.json');
    this.debugDir = join(this.root, 'debug');
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.browserProfile, { recursive: true });
    await mkdir(this.debugDir, { recursive: true });
  }

  async loadSettings(): Promise<ColabSettings> {
    try {
      const raw = await readFile(this.settingsFile, 'utf-8');
      return JSON.parse(raw) as ColabSettings;
    } catch {
      return {};
    }
  }

  async saveSettings(settings: ColabSettings): Promise<void> {
    await this.ensureDirs();
    await writeFile(this.settingsFile, JSON.stringify(settings, null, 2));
  }

  async saveSession(session: Record<string, unknown>): Promise<void> {
    await this.ensureDirs();
    await writeFile(this.sessionFile, JSON.stringify(session, null, 2));
  }

  async loadSession(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(this.sessionFile, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async clearSession(): Promise<void> {
    try {
      await writeFile(this.sessionFile, '{}');
    } catch {
      // ignore
    }
  }
}
