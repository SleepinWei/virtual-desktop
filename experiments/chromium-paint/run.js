import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createPaintLab } from './server.js';
import { capturePaint } from './capture.js';
import { verifyReplay } from './verify.js';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: 'test-results/chromium-paint' },
  serve: { type: 'boolean', default: false },
  'capture-only': { type: 'boolean', default: false },
  'headless-probe': { type: 'boolean', default: false },
  'producer-buffer-bytes': { type: 'string', default: '33554432' },
} });
const outputDir = resolve(values.output);
await mkdir(outputDir, { recursive: true });
// A failed run must not leave an older success manifest/report looking current.
for (const name of ['capture.json', 'replay.json', 'experiment.json', 'headless-report.json']) await rm(resolve(outputDir, name), { force: true });
const lab = createPaintLab({ outputDir }), baseUrl = await lab.listen();
let hold = false;
try {
  if (values['headless-probe']) {
    const { runHeadlessProbe } = await import('./headless-probe.js');
    const result = await runHeadlessProbe({ url: baseUrl + '/fixture.html', outputDir,
      ...(process.env.HEADLESS_SHELL_EXECUTABLE_PATH ? { executablePath: process.env.HEADLESS_SHELL_EXECUTABLE_PATH } : {}) });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'unsupported' || result.status === 'failed' || result.status === 'insufficient-trace') process.exitCode = 1;
  } else {
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const capture = await capturePaint({ url: baseUrl + '/fixture.html', outputDir, executablePath,
      producerBufferBytes: Number(values['producer-buffer-bytes']) });
    const replay = values['capture-only'] ? null : await verifyReplay({ baseUrl, outputDir, executablePath, manifest: capture });
    const result = { version: 1, outputDir,
      browser: { product: capture.browser.product, version: capture.browser.version,
        revision: capture.browser.revision, launchArgs: capture.browser.launchArgs },
      stages: capture.stages.map(stage => ({ name: stage.name, pictures: stage.pictures.length, recordedPictures: stage.recordedPictures.length })),
      trace: { records: capture.trace.eventCount, complete: capture.acceptance.traceComplete,
        dataLossOccurred: capture.trace.dataLossOccurred, raster: capture.trace.raster, draw: capture.trace.draw },
      nativePicturesCaptured: capture.acceptance.nativePicturesCaptured,
      clientReplayRendered: replay?.clientReplayRendered ?? null,
      fixtureReplayPassed: replay?.fixtureReplayPassed ?? null,
      serverRasterBypassed: false, engineSplitGate: 'not-passed',
      explanation: 'Native-paint export and client replay experiment. Stock Chromium still rasterizes; no production backend change.',
    };
    await writeFile(resolve(outputDir, 'experiment.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.nativePicturesCaptured || !result.trace.complete || replay && !replay.fixtureReplayPassed) process.exitCode = 1;
    if (values.serve) {
      hold = true;
      console.log(`Native paint replay lab: ${baseUrl}`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await lab.close(); process.exit(process.exitCode || 0); });
    }
  }
} finally { if (!hold) await lab.close(); }
