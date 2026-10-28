import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { captureLaunchArgs, findPageProvenance, loopbackUrl, recordTrace, settlePage, analyzeTrace } from './capture.js';
import { selectNativeFrame } from './native-frame.js';

export const FRAME_STAGES = ['before', 'changed', 'scrolled', 'removed'];
export async function frameFixtureFingerprint() {
  return Object.fromEntries(await Promise.all(['frames.html', 'frames.css', 'frames.js', 'fonts/fixture-sans.otf'].map(async name =>
    [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
}
export async function advanceFrameFixture(page, name, viewport) {
  if (!FRAME_STAGES.includes(name)) throw new Error('Unknown frame fixture stage');
  if (name === 'before') {
    await page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
    await settlePage(page);
    await page.setViewportSize(viewport);
  } else {
    await page.locator('#advance').click();
    if (name === 'scrolled') {
      await page.mouse.move(800, 400);
      await page.mouse.wheel(0, 180);
      await page.waitForFunction(() => document.querySelector('#scroller').scrollTop === 180, undefined, { timeout: 5000 });
    }
  }
  await settlePage(page);
  // rAF precedes the compositor submission; allow its separate thread to finish
  // before writing the native timestamp boundary (never use trace delivery order).
  await page.waitForTimeout(120);
  const phase = await page.locator('#phase').textContent();
  if (phase !== name) throw new Error(`Fixture phase ${phase} differs from ${name}`);
  return { phase, scrollTop: await page.locator('#scroller').evaluate(element => element.scrollTop),
    removablePresent: await page.locator('#removable').count() === 1 };
}

// No screenshot API, pixel decoder or DOM-derived drawing payload in this path.
export async function captureFrames({ url, executablePath, outputDir, viewport = { width: 960, height: 720 } }) {
  const fixtureUrl = loopbackUrl(url);
  if (new URL(fixtureUrl).pathname !== '/frames.html') throw new Error('Expected the trusted /frames.html fixture');
  if (!executablePath) throw new Error('Native frame capture requires an explicit patched executablePath');
  await mkdir(join(outputDir, 'pictures'), { recursive: true });
  const args = captureLaunchArgs({ remotePaint: true, noDisplay: true, producerBufferBytes: 33554432 });
  const browser = await chromium.launch({ executablePath, headless: true, args });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const fixtureSha256 = await frameFixtureFingerprint();
    for (const [name, expected] of Object.entries(fixtureSha256)) {
      const response = await context.request.get(new URL('/' + name, fixtureUrl).href);
      if (!response.ok() || createHash('sha256').update(await response.body()).digest('hex') !== expected) throw new Error('Fixture asset differs from the pinned local source: ' + name);
    }
    const page = await context.newPage();
    const response = await page.goto(fixtureUrl, { waitUntil: 'load', timeout: 30000 });
    if (!response?.ok()) throw new Error('Native frame fixture navigation failed');
    await settlePage(page);
    const cdp = await context.newCDPSession(page), browserInfo = await cdp.send('Browser.getVersion');
    const run = randomUUID(), markers = [], semanticStates = [];
    const trace = await recordTrace(cdp, async () => {
      for (const name of FRAME_STAGES) {
        const start = `${run}:${name}:start`, end = `${run}:${name}:end`;
        await page.evaluate(mark => performance.mark(mark), start);
        semanticStates.push(await advanceFrameFixture(page, name, viewport));
        await page.evaluate(mark => performance.mark(mark), end);
        markers.push({ name, start, end });
      }
    });
    await writeFile(join(outputDir, 'frame-trace.json'), JSON.stringify({ traceEvents: trace.events,
      dataLossOccurred: trace.dataLossOccurred, requestedStageMarkers: markers }));
    if (trace.dataLossOccurred !== false) throw new Error('Native frame trace is incomplete');
    const provenance = findPageProvenance(trace.events, fixtureUrl);
    const timestamp = name => {
      const event = trace.events.find(event => event.name === name && event.cat?.includes('blink.user_timing') && provenance.rendererPids.includes(event.pid));
      if (!Number.isFinite(event?.ts)) throw new Error('Missing native frame stage marker: ' + name);
      return event.ts;
    };
    const stages = [];
    for (const marker of markers) {
      const start = timestamp(marker.start), end = timestamp(marker.end);
      const selected = selectNativeFrame(trace.events, { rendererPids: provenance.rendererPids, start, end, viewport });
      for (const [id, data] of selected.bytes) await writeFile(join(outputDir, `pictures/${id}.skp`), data);
      stages.push({ name: marker.name, frame: selected.frame, evidence: {
        eventIndex: selected.eventIndex, observedFrames: selected.observedFrames, start, end,
      } });
    }
    if (new Set(stages.map(stage => `${stage.frame.native.pid}:${stage.frame.native.treeId}`)).size !== 1) throw new Error('Fixture stages came from different native trees');
    const manifest = { version: 1, capturedAt: new Date().toISOString(), url: fixtureUrl, viewport, browser: {
      ...browserInfo, version: browser.version(), executablePath, launchArgs: args },
      provenance, stages, semanticStates, fixtureSha256, trace: { path: 'frame-trace.json', complete: true, ...analyzeTrace(trace.events) },
      fontPolicy: 'Pinned fixture webfont and explicit macOS antialiased (A8) CSS, matching the bounded CanvasKit text profile.',
      scope: 'Native active-tree full snapshots; 2D picture/solid layers, rectangular clips and SrcOver opacity groups only.',
      engineSplitGate: 'not-passed', serverRasterBypassed: false };
    if (JSON.stringify(fixtureSha256) !== JSON.stringify(await frameFixtureFingerprint())) throw new Error('Fixture source changed during capture');
    await writeFile(join(outputDir, 'frame-capture.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally { await browser.close(); }
}
