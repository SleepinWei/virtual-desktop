import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { comparePixels, verifyReplay } from '../experiments/chromium-paint/verify.js';

test('fixture visual comparison rejects wrong dimensions, missing paint and changed solid content', () => {
  const image = (width, height, rgba) => ({ width, height, data: Uint8ClampedArray.from(Array.from({ length: width * height }, () => rgba).flat()) });
  const expected = image(10, 10, [37, 99, 235, 255]);
  assert.equal(comparePixels(expected, expected).passed, true);
  assert.equal(comparePixels(expected, image(20, 5, [37, 99, 235, 255])).passed, false);
  assert.equal(comparePixels(expected, image(10, 10, [255, 255, 255, 255])).passed, false);
  assert.equal(comparePixels(expected, image(10, 10, [22, 163, 74, 255])).passed, false);
  assert.equal(comparePixels(expected, image(10, 10, [37, 99, 235, 0])).passed, false);
  assert.equal(comparePixels(image(0, 0, []), image(0, 0, [])).passed, false);
});

test('empty or unsafe capture stages fail before browser launch and replace an older passing report', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'chromium-replay-test-'));
  try {
    for (const stages of [[], [{ name: '../outside', pictures: [{}] }, { name: 'after', pictures: [{}] }]]) {
      await writeFile(join(outputDir, 'replay.json'), JSON.stringify({ fixtureReplayPassed: true }));
      const report = await verifyReplay({ baseUrl: 'http://127.0.0.1:1', outputDir,
        executablePath: '/must-not-launch', manifest: { version: 1, viewport: { width: 960, height: 720 }, stages } });
      assert.equal(report.fixtureReplayPassed, false);
      assert.equal(report.localValidationBrowser, null);
      assert.match(report.errors[0], /nonempty before\/after/);
      assert.equal(JSON.parse(await readFile(join(outputDir, 'replay.json'), 'utf8')).fixtureReplayPassed, false);
    }
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});
