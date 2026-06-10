#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { Command } from 'commander';

import { ColabClient } from '../client/ColabClient.js';
import { ExecutionError } from '../errors/index.js';

let globalClient: ColabClient | null = null;
let jsonMode = false;

function output(data: unknown): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}

async function getClient(): Promise<ColabClient> {
  if (!globalClient) {
    globalClient = new ColabClient();
  }
  return globalClient;
}

async function ensureConnected(client: ColabClient, opts: { headless?: boolean; gpu?: string }): Promise<void> {
  const status = client.status();
  if (!status.connected) {
    await client.connect({
      headless: opts.headless ?? true,
      gpu: opts.gpu as 'cpu' | 't4' | 'a100' | undefined,
    });
  }
}

const program = new Command();

program
  .name('colab-dev')
  .description('CLI for Google Colab SDK')
  .option('--json', 'JSON output')
  .hook('preAction', (thisCommand) => {
    jsonMode = Boolean(thisCommand.opts().json);
  });

program
  .command('login')
  .description('Interactive Google login (supports 2FA)')
  .option('--remote-cdp <port>', 'Expose Chrome DevTools port for remote 2FA', (v) => parseInt(v, 10))
  .action(async (opts: { remoteCdp?: number }) => {
    try {
      const client = await getClient();
      output({ dataDir: client.paths.root, message: 'Opening browser for Google login...' });
      await client.auth.login({
        remoteCdpPort: opts.remoteCdp,
        exportState: true,
      });
      output({ status: 'logged_in', dataDir: client.paths.root });
    } catch (err) {
      printError(err);
    }
  });

program
  .command('connect')
  .description('Connect to Colab')
  .option('--headless', 'Run browser headless', true)
  .option('--no-headless', 'Show browser window')
  .option('--gpu <type>', 'GPU type: cpu, t4, a100, l4, tpu')
  .option('--notebook <url>', 'Notebook URL to open')
  .action(async (opts: { headless: boolean; gpu?: string; notebook?: string }) => {
    try {
      const client = await getClient();
      const info = opts.notebook
        ? await client.openNotebook(opts.notebook, { headless: opts.headless, gpu: opts.gpu as 't4' | undefined })
        : await client.connect({ headless: opts.headless, gpu: opts.gpu as 't4' | undefined });
      output({ status: 'connected', ...info, dataDir: client.paths.root });
    } catch (err) {
      printError(err);
    }
  });

program
  .command('exec <code>')
  .description('Execute Python code on Colab')
  .option('-f, --file <path>', 'Read code from file')
  .option('--stream', 'Stream output while running')
  .action(async (code: string, opts: { file?: string; stream?: boolean }) => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});

      let source = code;
      if (opts.file) {
        source = await readFile(opts.file, 'utf-8');
      }

      if (opts.stream) {
        const cell = await client.cells.createCode(source);
        for await (const chunk of client.execute.streamCell(cell.cellId)) {
          output({ chunk });
        }
      } else {
        const result = await client.execute.runCode(source);
        output(result);
      }
    } catch (err) {
      if (err instanceof ExecutionError) {
        output({ error: err.message, result: err.result });
      } else {
        printError(err);
      }
    }
  });

const cells = program.command('cells').description('Notebook cell operations');

cells
  .command('list')
  .description('List notebook cells')
  .action(async () => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      output(await client.cells.list());
    } catch (err) {
      printError(err);
    }
  });

cells
  .command('add <content>')
  .description('Add a cell')
  .option('--index <n>', 'Cell index', (v) => parseInt(v, 10))
  .option('--markdown', 'Add markdown cell')
  .action(async (content: string, opts: { index?: number; markdown?: boolean }) => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      const cell = opts.markdown
        ? await client.cells.createMarkdown(content, { index: opts.index })
        : await client.cells.createCode(content, { index: opts.index });
      output(cell);
    } catch (err) {
      printError(err);
    }
  });

cells
  .command('edit <id> <content>')
  .description('Edit a cell')
  .action(async (id: string, content: string) => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      output(await client.cells.edit(id, content));
    } catch (err) {
      printError(err);
    }
  });

cells
  .command('rm <id>')
  .description('Remove a cell')
  .action(async (id: string) => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      await client.cells.remove(id);
      output({ status: 'removed', cellId: id });
    } catch (err) {
      printError(err);
    }
  });

cells
  .command('move <id>')
  .description('Move a cell')
  .requiredOption('--to <n>', 'Target index', (v) => parseInt(v, 10))
  .action(async (id: string, opts: { to: number }) => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      await client.cells.move(id, opts.to);
      output({ status: 'moved', cellId: id, toIndex: opts.to });
    } catch (err) {
      printError(err);
    }
  });

const runtime = program.command('runtime').description('Runtime operations');

runtime
  .command('gpu <type>')
  .description('Change GPU type')
  .action(async (type: string) => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      await client.runtime.select(type as 't4');
      output({ status: 'changed', gpu: type });
    } catch (err) {
      printError(err);
    }
  });

runtime
  .command('stop')
  .description('Disconnect and delete runtime')
  .action(async () => {
    try {
      const client = await getClient();
      await ensureConnected(client, {});
      await client.runtime.disconnect();
      output({ status: 'runtime_stopped' });
    } catch (err) {
      printError(err);
    }
  });

program
  .command('status')
  .description('Connection status')
  .option('--health', 'Include runtime health')
  .action(async (opts: { health?: boolean }) => {
    try {
      const client = await getClient();
      const info = client.status();
      const payload: Record<string, unknown> = { ...info, dataDir: client.paths.root };
      if (opts.health && info.connected) {
        payload.health = await client.runtime.health();
      }
      output(payload);
    } catch (err) {
      printError(err);
    }
  });

program
  .command('stop')
  .description('Interrupt execution and disconnect')
  .action(async () => {
    try {
      const client = await getClient();
      if (client.status().connected) {
        await client.execute.interrupt().catch(() => {});
      }
      await client.disconnect();
      globalClient = null;
      output({ status: 'stopped' });
    } catch (err) {
      printError(err);
    }
  });

program.parseAsync(process.argv).catch(printError);
