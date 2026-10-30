import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WorkerClient } from '../src/sessions.js';

test('display comparisons reject unbounded samples before creating browsers or touching the root', async () => {
  for (const [script, extra, message] of [
    ['guarded-native-tests.js', ['--task', 'display'], /iterations 8\.\.20/],
    ['compare-display.js', ['--canvaskit', '/must-not-read'], /8\.\.20 iterations/],
  ]) for (const iterations of ['0', '7', '21', 'Infinity', '1.5']) {
    const command = fileURLToPath(new URL('../experiments/chromium-engine/' + script, import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, [command, '--root', '/must-not-read', '--output', '/must-not-write',
      '--iterations', iterations, ...extra]), message);
  }
});

test('the isolated screenshot worker rejects unknown formats before starting Chromium', async t => {
  const worker = new WorkerClient(() => {}, { backend: 'traditional-benchmark' }); t.after(() => worker.stop());
  await assert.rejects(worker.call('init', { imageFormat: 'webm' }), /JPEG80 or lossless PNG/);
  assert.equal(worker.browserPid, undefined);
});
