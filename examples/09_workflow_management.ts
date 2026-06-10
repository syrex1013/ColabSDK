/**
 * Workflow management: list, upload, load, run, unload (with and without streaming).
 *
 *   bun run example:workflows
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowExecutionError } from '../src/index.js';
import { createAuthenticatedClient } from './_helpers.js';

async function main(): Promise<void> {
  const client = await createAuthenticatedClient();
  const workflowPath = join(
    fileURLToPath(new URL('.', import.meta.url)),
    'workflows',
    'hello-world.workflow.json',
  );

  try {
    const notebookUrl = await client.createNotebook();
    await client.connect({
      headless: process.env.COLAB_HEADLESS !== '0',
      notebookUrl,
    });

    console.log('Uploading local workflow...');
    const uploaded = await client.workflows.upload(workflowPath, { load: true });
    console.log('Uploaded:', uploaded);

    console.log('\nLocal workflows:');
    console.log(await client.workflows.list('local'));

    console.log('\nUploaded/loaded workflows:');
    console.log(await client.workflows.list('uploaded'));

    console.log('\nRunning workflow (non-streaming)...');
    const result = await client.workflows.run('hello-world', { autoLoad: false });
    console.log('Run result:', result.success, `(${result.steps.length} steps)`);

    console.log('\nRunning workflow (streaming)...');
    for await (const chunk of client.workflows.runStream('hello-world', { autoLoad: false })) {
      if (chunk.type === 'result' || chunk.type === 'stdout') {
        process.stdout.write(chunk.text);
      }
    }
    console.log('\nStream complete.');

    console.log('\nUnloading workflow...');
    await client.workflows.unload('hello-world');
    console.log('Remaining loaded:', await client.workflows.list('uploaded'));
  } catch (err) {
    if (err instanceof WorkflowExecutionError) {
      console.error(`Workflow failed at step ${err.stepIndex}: ${err.message}`);
    }
    throw err;
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
