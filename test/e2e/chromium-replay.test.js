import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { createPaintLab } from '../../experiments/chromium-paint/server.js';

// Native captures are intentionally not committed or fabricated in CI.
test('repeated native replay releases software surface memory, with a leaking control', {
  skip: !process.env.CHROMIUM_CAPTURE_DIRECTORY, timeout: 120000,
}, async () => {
  const directory = resolve(process.env.CHROMIUM_CAPTURE_DIRECTORY);
  const manifest = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'));
  const lab = createPaintLab({ outputDir: directory, canvasKitDirectory: process.env.CANVASKIT_DIRECTORY });
  const results = [];
  let browser;
  try {
    const baseUrl = await lab.listen();
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || manifest.browser.executablePath });
    const source = await readFile(new URL('../../experiments/chromium-paint/replay.js', import.meta.url), 'utf8');
    for (const leakingControl of [false, true]) {
      const context = await browser.newContext({ viewport: manifest.viewport });
      try {
        const page = await context.newPage();
        await page.route('**/replay.js', async route => {
          // Instrument heap size without changing the native SKP or WASM.
          // The negative control omits the software pixel allocation cleanup.
          const script = leakingControl ? source.replace('surface?.dispose();', 'surface?.delete();') : source;
          await route.fulfill({ contentType: 'text/javascript', body: script +
            '\nwindow.__replayHeapBytes = () => kit.HEAPU8.byteLength;\n' });
        });
        await page.goto(baseUrl);
        await page.waitForFunction(() => document.documentElement.dataset.status === 'ready');
        const baseline = await page.evaluate(() => window.__replayHeapBytes());
        let peak = baseline;
        for (let index = 0; index < 64; index++) {
          const stage = index % 2 === 0 ? 1 : 0;
          await page.locator('#stage').selectOption(String(stage));
          await page.waitForFunction(name => document.documentElement.dataset.status === 'ready' &&
            document.querySelector('#skp').dataset.stage === name, manifest.stages[stage].name);
          peak = Math.max(peak, await page.evaluate(() => window.__replayHeapBytes()));
        }
        results.push({ leakingControl, cycles: 64, baselineBytes: baseline, peakBytes: peak, growthBytes: peak - baseline });
      } finally { await context.close(); }
    }
  } finally { if (browser) await browser.close(); await lab.close(); }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/chromium-replay-memory.json', JSON.stringify({
    scope: 'CanvasKit WASM heap growth only; excludes browser/JS/GPU memory and does not measure total RSS', results,
  }, null, 2));
  assert.ok(results[0].growthBytes <= 8 * 1024 ** 2, 'Normal replay should reuse its pixel allocation');
  assert.ok(results[1].growthBytes > 8 * 1024 ** 2, 'Leaking control must grow, otherwise this check is inconclusive');
});
