import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromium } from 'playwright';

async function decoded(bytes) {
  const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

export function comparePixels(reference, actual) {
  if (reference.width !== actual.width || reference.height !== actual.height) return { passed: false, error: 'Image dimensions differ' };
  if (!Number.isInteger(reference.width) || !Number.isInteger(reference.height) || reference.width < 1 || reference.height < 1 ||
      reference.data.length !== reference.width * reference.height * 4 || actual.data.length !== actual.width * actual.height * 4) {
    return { passed: false, error: 'Invalid RGBA image data' };
  }
  let absoluteError = 0, significant = 0;
  for (let index = 0; index < reference.data.length; index += 4) {
    let maximum = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(reference.data[index + channel] - actual.data[index + channel]);
      if (channel < 3) absoluteError += delta;
      maximum = Math.max(maximum, delta);
    }
    if (maximum > 32) significant++;
  }
  const meanAbsoluteChannelError = absoluteError / (reference.width * reference.height * 3);
  const pixelsOver32Fraction = significant / (reference.width * reference.height);
  return { passed: meanAbsoluteChannelError <= 3 && pixelsOver32Fraction <= 0.02,
    meanAbsoluteChannelError, pixelsOver32Fraction,
    limits: { maxMeanAbsoluteChannelError: 3, maxPixelsOver32Fraction: 0.02 },
    scope: 'Trusted fixture comparison allowing antialiasing differences; not general website visual compatibility' };
}

function crop(image, bounds) {
  const left = Math.max(0, Math.floor(bounds.x)), top = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(image.width, Math.ceil(bounds.x + bounds.width)), bottom = Math.min(image.height, Math.ceil(bounds.y + bounds.height));
  const width = right - left, height = bottom - top;
  const data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  for (let row = 0; row < height; row++) data.set(image.data.subarray(((top + row) * image.width + left) * 4, ((top + row) * image.width + right) * 4), row * width * 4);
  return { width, height, data };
}

// This is a separate LOCAL validation browser. The capture worker has already
// closed before this runs. Only this client/reference harness writes PNG pixels.
export async function verifyReplay({ baseUrl, outputDir, executablePath, manifest }) {
  await mkdir(outputDir, { recursive: true });
  const stages = [], errors = [];
  let browser, browserVersion = null, replayRuntime = null;
  try {
    if (manifest?.version !== 1 || manifest.viewport?.width !== 960 || manifest.viewport?.height !== 720 ||
        !Array.isArray(manifest.stages) || manifest.stages.length !== 2 ||
        manifest.stages.some((stage, index) => stage.name !== ['before', 'after'][index] || !Array.isArray(stage.pictures) || !stage.pictures.length)) {
      throw new Error('Expected a nonempty before/after capture of the 960×720 trusted fixture');
    }
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    browserVersion = browser.version();
    const context = await browser.newContext({ viewport: manifest.viewport, deviceScaleFactor: 1 });
    const reference = await context.newPage(), client = await context.newPage();
    client.on('pageerror', error => errors.push(error.message));
    await reference.goto(baseUrl + '/fixture.html');
    await reference.evaluate(() => document.fonts.ready);
    await client.goto(baseUrl + '/');
    for (let index = 0; index < manifest.stages.length; index++) {
      const stage = manifest.stages[index];
      if (index) { await reference.locator('#increment').click(); await client.locator('#stage').selectOption(String(index)); }
      await client.waitForFunction(name => {
        const status = document.documentElement.dataset.status;
        return status === 'unsupported' || (status === 'ready' && document.querySelector('#skp').dataset.stage === name);
      }, stage.name, { timeout: 30000 });
      const state = await client.locator('html').getAttribute('data-status');
      const details = JSON.parse(await client.locator('#result').textContent());
      if (state !== 'ready') { stages.push({ name: stage.name, passed: false, status: state, details }); break; }
      replayRuntime = details.runtime;
      const sourceMatched = stage.pictures.some(picture => picture.path === details.picture && picture.sha256 === details.sha256 && picture.bytes === details.bytes);
      if (!sourceMatched || details.stage !== stage.name) throw new Error(`Replay source does not match captured stage ${stage.name}`);
      const png = await client.locator('#skp').evaluate(canvas => canvas.toDataURL('image/png'));
      const clientBytes = Buffer.from(png.split(',')[1], 'base64');
      const referenceBytes = await reference.screenshot({ path: join(outputDir, `reference-${stage.name}.png`) });
      await writeFile(join(outputDir, `client-${stage.name}.png`), clientBytes);
      const expected = await decoded(referenceBytes), actual = await decoded(clientBytes);
      const visual = comparePixels(expected, actual), regions = [];
      // Bounds come only from this LOCAL baseline fixture, never from a capture
      // payload or a DOM mirrored into the replay client. Text must pass on its
      // own; a correct large background cannot hide absent glyphs.
      for (const selector of ['h1', '#description', '#count', '#status', '#increment']) {
        const locator = reference.locator(selector), bounds = await locator.boundingBox();
        if (!bounds) { regions.push({ selector, passed: false, error: 'Reference region is missing' }); continue; }
        regions.push({ selector, bounds, ...comparePixels(crop(expected, bounds), crop(actual, bounds)) });
      }
      const referenceCount = await reference.locator('#count').textContent();
      const expectedCount = String(index);
      const statePassed = referenceCount === expectedCount;
      stages.push({ name: stage.name, passed: visual.passed && regions.every(region => region.passed) && statePassed, sourceMatched, details, visual, regions,
        referenceState: { count: referenceCount, expectedCount, passed: statePassed },
        images: { reference: `reference-${stage.name}.png`, client: `client-${stage.name}.png` } });
    }
    await client.screenshot({ path: join(outputDir, 'replay-lab.png'), fullPage: true });
  } catch (error) { errors.push(error.message); }
  finally { if (browser) await browser.close().catch(error => errors.push(`Browser cleanup: ${error.message}`)); }
  const report = { version: 1, recordedAt: new Date().toISOString(), localValidationBrowser: browserVersion,
    canvasKit: replayRuntime?.id ?? null, replayRuntime, stages, errors,
    clientReplayRendered: stages.length === 2 && stages.every(stage => stage.sourceMatched) && errors.length === 0,
    fixtureReplayPassed: stages.length === 2 && stages.every(stage => stage.passed) && errors.length === 0,
    serverRasterBypassed: false,
    imageProvenance: 'PNGs are generated in the separate local replay/reference browser, never by the capture module.',
  };
  await writeFile(join(outputDir, 'replay.json'), JSON.stringify(report, null, 2));
  return report;
}
