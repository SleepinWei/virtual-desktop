import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { FRAME_STAGES, advanceFrameFixture } from './frame-capture.js';
import { validateFrame, layerIds } from './frame-protocol.js';
import { comparePixels, decoded, crop } from './verify.js';

const canvasPng = async page => Buffer.from((await page.locator('#skp').evaluate(canvas => canvas.toDataURL('image/png'))).split(',')[1], 'base64');
async function ready(page, name) {
  await page.waitForFunction(stage => document.documentElement.dataset.status === 'unsupported' ||
    (document.documentElement.dataset.status === 'ready' && document.querySelector('#skp').dataset.stage === stage), name, { timeout: 30000 });
  const details = JSON.parse(await page.locator('#result').textContent());
  if (await page.locator('html').getAttribute('data-status') !== 'ready') throw new Error(details.error || 'Client frame unsupported');
  return details;
}

// Independent ordinary-mode LOCAL browser. Capture has already closed. DOM
// bounds and PNGs here are validation evidence, never server replay payloads.
export async function verifyFrames({ baseUrl, outputDir, executablePath, manifest }) {
  const report = { version: 1, recordedAt: new Date().toISOString(), stages: [], errors: [],
    passed: false, engineSplitGate: 'not-passed', serverRasterBypassed: false,
    imageProvenance: 'Independent local ordinary-mode reference/replay browser; no pixels captured by the server recorder.' };
  let browser;
  try {
    if (manifest?.version !== 1 || JSON.stringify(manifest.stages?.map(stage => stage.name)) !== JSON.stringify(FRAME_STAGES)) throw new Error('Expected all four native frame stages');
    manifest.stages.forEach(stage => validateFrame(stage.frame));
    browser = await chromium.launch({ executablePath, headless: true });
    report.localValidationBrowser = browser.version();
    const context = await browser.newContext({ viewport: manifest.viewport, deviceScaleFactor: 1 });
    const reference = await context.newPage(), client = await context.newPage();
    client.on('pageerror', error => report.errors.push(error.message));
    await reference.goto(baseUrl + '/frames.html');
    await client.goto(baseUrl + '/');
    let removalBounds;
    for (const stage of manifest.stages) {
      const referenceState = await advanceFrameFixture(reference, stage.name, manifest.viewport);
      if (stage.name !== FRAME_STAGES[0]) await client.locator('#stage').selectOption(stage.name);
      const details = await ready(client, stage.name);
      if (details.frameId !== stage.frame.id || details.receiver.seq !== details.channel.acked || details.channel.pending !== 0) throw new Error('Presented frame/ACK differs from captured native source');
      const clientBytes = await canvasPng(client);
      const referenceBytes = await reference.screenshot({ path: join(outputDir, `reference-frame-${stage.name}.png`) });
      await writeFile(join(outputDir, `client-frame-${stage.name}.png`), clientBytes);
      const expected = await decoded(referenceBytes), actual = await decoded(clientBytes), regions = [];
      removalBounds ||= await reference.locator('#removable').boundingBox();
      for (const selector of ['header', '#scene', '#back', '#group', '#scroller']) {
        const bounds = await reference.locator(selector).boundingBox();
        if (!bounds) throw new Error('Missing local validation region: ' + selector);
        regions.push({ selector, bounds, ...comparePixels(crop(expected, bounds), crop(actual, bounds)) });
      }
      // A fixed region from the independent original page must turn blank after
      // the native layer is deleted; a large background cannot hide a ghost.
      regions.push({ selector: 'original removal region', bounds: removalBounds,
        ...comparePixels(crop(expected, removalBounds), crop(actual, removalBounds)) });
      const red = await reference.locator('#red').boundingBox(), yellow = await reference.locator('#yellow').boundingBox();
      const overlap = { x: Math.max(red.x, yellow.x), y: Math.max(red.y, yellow.y),
        width: Math.min(red.x + red.width, yellow.x + yellow.width) - Math.max(red.x, yellow.x),
        height: Math.min(red.y + red.height, yellow.y + yellow.height) - Math.max(red.y, yellow.y) };
      regions.push({ selector: 'overlapping opacity children', bounds: overlap,
        ...comparePixels(crop(expected, overlap), crop(actual, overlap)) });
      const visual = comparePixels(expected, actual), expectedState = manifest.semanticStates.find(state => state.phase === stage.name);
      const semanticsPassed = JSON.stringify(referenceState) === JSON.stringify(expectedState);
      const passed = visual.passed && regions.every(region => region.passed) && semanticsPassed;
      report.stages.push({ name: stage.name, passed, native: stage.frame.native,
        layerIds: [...layerIds(stage.frame)], surfaces: stage.frame.surfaces.length,
        visual, regions, referenceState, semanticsPassed, details,
        images: { reference: `reference-frame-${stage.name}.png`, client: `client-frame-${stage.name}.png` } });
      if (!passed) throw new Error('Native frame visual or semantic comparison failed: ' + stage.name);
    }
    const beforeStale = await canvasPng(client);
    const stale = await client.evaluate(async () => {
      const previous = window.frameLab.state(), packet = window.frameLab.packets[0];
      const response = await window.frameLab.consume(packet);
      return { previous, response, current: window.frameLab.state() };
    });
    report.staleFrame = { ...stale, pixelsUnchanged: beforeStale.equals(await canvasPng(client)) };
    if (stale.response.status !== 'stale' || stale.previous.receiver.seq !== stale.current.receiver.seq || !report.staleFrame.pixelsUnchanged) throw new Error('A stale native frame overwrote visible state');

    // Actual corrupt resource response, with a successful frame already shown.
    // It must fail SHA-256 verification, preserve those pixels and send no ACK.
    const badClient = await context.newPage();
    await badClient.goto(baseUrl + '/'); await ready(badClient, 'before');
    const original = await canvasPng(badClient);
    let corrupted = false;
    await badClient.route('**/pictures/*.skp', async route => {
      if (corrupted) return route.continue();
      const response = await route.fetch(), bytes = await response.body();
      bytes[0] ^= 1; corrupted = true;
      await route.fulfill({ response, body: bytes });
    });
    await badClient.locator('#stage').selectOption('changed');
    await badClient.waitForFunction(() => document.documentElement.dataset.status === 'unsupported', undefined, { timeout: 30000 });
    const failure = JSON.parse(await badClient.locator('#result').textContent()), state = await badClient.evaluate(() => window.frameLab.state());
    const transport = await badClient.evaluate(async epoch => (await fetch(`/api/stats?epoch=${epoch}`)).json(), state.receiver.epoch);
    report.corruptResource = { injected: corrupted, failure, state, channel: transport.channel,
      pixelsUnchanged: original.equals(await canvasPng(badClient)) };
    if (!corrupted || !failure.error?.includes('SHA-256') || state.receiver.seq !== 1 || transport.channel.acked !== 1 || !report.corruptResource.pixelsUnchanged) throw new Error('Corrupt resource did not fail atomically');
    await badClient.close();
    await client.screenshot({ path: join(outputDir, 'frame-replay-lab.png'), fullPage: true });
    report.passed = report.stages.length === FRAME_STAGES.length && report.errors.length === 0;
  } catch (error) { report.errors.push(error.message); }
  finally { if (browser) await browser.close(); }
  await writeFile(join(outputDir, 'frame-replay.json'), JSON.stringify(report, null, 2));
  return report;
}
