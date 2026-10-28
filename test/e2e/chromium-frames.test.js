import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createFrameLab } from '../../experiments/chromium-paint/frame-server.js';
import { frameFixtureFingerprint } from '../../experiments/chromium-paint/frame-capture.js';
import { verifyFrames } from '../../experiments/chromium-paint/frame-verify.js';

const captureDirectory = process.env.CHROMIUM_FRAME_CAPTURE_DIRECTORY;
test('real native frames replay transform, opacity, clipping, scroll and removal with atomic transport failures', {
  skip: captureDirectory ? false : 'Set CHROMIUM_FRAME_CAPTURE_DIRECTORY to verified native multi-layer captures', timeout: 60000,
}, async () => {
  assert.ok(process.env.CANVASKIT_DIRECTORY, 'A matching verified CanvasKit directory is required');
  const input = resolve(captureDirectory), output = resolve('test-results/chromium-frames-e2e');
  const manifest = JSON.parse(await readFile(join(input, 'frame-capture.json'), 'utf8'));
  assert.deepEqual(manifest.fixtureSha256, await frameFixtureFingerprint(), 'Saved fixture sources changed; capture again');
  await mkdir(output, { recursive: true });
  const lab = createFrameLab({ outputDir: input, canvasKitDirectory: process.env.CANVASKIT_DIRECTORY });
  try {
    const baseUrl = await lab.listen();
    const report = await verifyFrames({ baseUrl, outputDir: output, manifest,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
    assert.equal(report.passed, true, JSON.stringify({ errors: report.errors, stages: report.stages.filter(stage => !stage.passed) }));
    assert.equal(report.staleFrame.pixelsUnchanged, true);
    assert.equal(report.corruptResource.pixelsUnchanged, true);
    assert.equal(report.corruptResource.channel.acked, 1);
  } finally { await lab.close(); }
});
