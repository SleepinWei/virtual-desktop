import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

// Chromium's DisplayItemList::EmitTraceSnapshot exports recording-canvas SKPs.
// This debug export does not disable the normal compositor/raster pipeline.
const TRACE_CATEGORIES = [
  'cc', 'gpu', 'viz', 'blink', 'blink.user_timing', 'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.picture',
  'disabled-by-default-devtools.timeline.layers',
  // Disabled categories are opt-in names, not a hierarchy under cc.debug.
  'disabled-by-default-cc.debug.picture',
];
const TRACE_CONFIG = { recordMode: 'recordAsMuchAsPossible', traceBufferSizeInKb: 131072,
  includedCategories: TRACE_CATEGORIES, excludedCategories: ['*'] };
const PRODUCER_BUFFER_SOURCE = 'https://chromium.googlesource.com/chromium/src/+/156.0.8078.48/services/tracing/public/cpp/tracing_features.cc';
const SKP_MAGIC = Buffer.from('skiapict');
const RASTER_EVENT = /(?:^RasterTask$|Raster(?:izer)?TaskImpl::RunOnWorkerThread|(?:RasterBuffer(?:Impl|Provider)?|RasterSource)::Playback|RasterDecoderImpl::(?:Do)?Raster|RasterCHROMIUM)/i;
const DRAW_EVENT = /(?:^DrawFrame$|(?:Display|SkiaRenderer|GLRenderer|DirectRenderer|LayerTreeHostImpl|ProxyImpl)::(?:DrawAndSwap|DrawLayers|DrawFrame|Draw$))/i;
// A Display::DrawAndSwap slice also surrounds aggregation-only frames. Count
// the renderer entry separately so a NullRenderer is not reported as drawing.
const PIXEL_DRAW_EVENT = /^(?:DirectRenderer|SkiaRenderer|SoftwareRenderer|GLRenderer)::DrawFrame$/;

function eventsOf(trace) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents;
  if (!Array.isArray(events)) throw new TypeError('Expected traceEvents or an array of trace events');
  return events;
}

/** A bounded, source-backed diagnostic setting; arbitrary Chrome flags are not accepted. */
export function producerLaunchArgs(producerBufferBytes) {
  if (producerBufferBytes === undefined) return [];
  if (!Number.isInteger(producerBufferBytes) || producerBufferBytes < 4 * 1024 * 1024 ||
      producerBufferBytes > 32 * 1024 * 1024 || producerBufferBytes % (32 * 1024) !== 0) {
    throw new TypeError('producerBufferBytes must be 4–32 MiB in multiples of 32 KiB');
  }
  // Chromium 156 tracing_features.cc defines the disabled-by-default feature
  // named kPerfettoBackendParams and its shared_memory_size_bytes parameter.
  return [`--enable-features=kPerfettoBackendParams:shared_memory_size_bytes/${producerBufferBytes}`];
}

export function captureLaunchArgs({ producerBufferBytes, remotePaint = false, noDisplay = false } = {}) {
  if (typeof remotePaint !== 'boolean') throw new TypeError('remotePaint must be boolean');
  if (typeof noDisplay !== 'boolean' || noDisplay && !remotePaint) throw new TypeError('noDisplay requires remotePaint');
  const producer = producerLaunchArgs(producerBufferBytes);
  const features = producer.map(argument => argument.slice('--enable-features='.length));
  if (remotePaint) features.push('VirtualDesktopRemotePaint');
  if (noDisplay) features.push('VirtualDesktopRemotePaintNoDisplay');
  return ['--enable-automation', ...(features.length ? [`--enable-features=${features.join(',')}`] : [])];
}

function withoutPicturePayloads(value) {
  if (Array.isArray(value)) return value.map(withoutPicturePayloads);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'skp64' && typeof item === 'string'
      ? { omitted: 'Original base64 payload is preserved in trace.json', base64Length: item.length }
      : withoutPicturePayloads(item),
  ]));
}

/** Extract native SKP payloads without interpreting DOM, text, or drawing ops. */
export function extractPictures(trace) {
  const events = eventsOf(trace);
  const layerScopes = events.flatMap((event, eventIndex) => event.name === 'UpdateLayer' && event.ph === 'X' &&
    Number.isFinite(event.ts) && Number.isFinite(event.dur) && event.args?.layerId != null
    ? [{ event, eventIndex }] : []);
  const pictures = [];
  events.forEach((event, eventIndex) => {
    function visit(value, path) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        const itemPath = [...path, key];
        if (key === 'skp64' && typeof item === 'string') {
          const base64 = item.replace(/\s/g, '');
          if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
            throw new Error(`Invalid SKP base64 at trace event ${eventIndex}: ${itemPath.join('.')}`);
          }
          const data = Buffer.from(base64, 'base64');
          if (!data.subarray(0, SKP_MAGIC.length).equals(SKP_MAGIC)) {
            throw new Error(`Invalid SKP file header at trace event ${eventIndex}: ${itemPath.join('.')}`);
          }
          const args = event.args || {};
          const enclosing = layerScopes.filter(scope => scope.event.pid === event.pid && scope.event.tid === event.tid &&
            scope.event.ts <= event.ts && event.ts <= scope.event.ts + scope.event.dur)
            .sort((a, b) => a.event.dur - b.event.dur)[0];
          const layerId = args.layer_id ?? args.layerId ?? args.snapshot?.layer_id ?? enclosing?.event.args.layerId;
          // Older Chromium uses pointer/object ids rather than explicit layer ids.
          const displayListId = args.id ?? event.id ?? event.id2?.local ?? event.id2?.global;
          pictures.push({
            eventIndex, payloadPath: itemPath.join('.'), layerId: layerId ?? null,
            layerEvidence: enclosing ? { source: 'enclosing UpdateLayer trace slice', eventIndex: enclosing.eventIndex,
              layerTreeId: enclosing.event.args.layerTreeId, args: structuredClone(enclosing.event.args) } : null,
            displayListId: displayListId ?? null,
            sourceFrameNumber: Number.isInteger(args.source_frame_number) ? args.source_frame_number : null,
            layerKey: layerId != null ? `layer:${event.pid}:${layerId}`
              : displayListId != null ? `display-list:${event.pid}:${displayListId}`
                : `unassociated:${eventIndex}:${itemPath.join('.')}`,
            data, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
            event: withoutPicturePayloads(event),
          });
        } else visit(item, itemPath);
      }
    }
    visit(event.args, ['args']);
  });
  return pictures;
}

/** Counts observed trace records, not raster executions or a proof of absence. */
export function analyzeTrace(trace) {
  const events = eventsOf(trace);
  function count(pattern) {
    const byName = {}, byPhase = {};
    let eventCount = 0;
    for (const event of events) {
      if (!pattern.test(event.name || '')) continue;
      eventCount++;
      byName[event.name] = (byName[event.name] || 0) + 1;
      byPhase[event.ph || '(missing)'] = (byPhase[event.ph || '(missing)'] || 0) + 1;
    }
    return { eventCount, byName, byPhase };
  }
  return {
    eventCount: events.length,
    raster: count(RASTER_EVENT), draw: count(DRAW_EVENT), pixelDraw: count(PIXEL_DRAW_EVENT),
    interpretation: 'Counts matching trace event records; begin/end records and nested slices may describe the same work. Unobserved events do not prove raster or draw work was bypassed.',
  };
}

export function findPageProvenance(trace, fixtureUrl) {
  const evidence = [];
  const wanted = new URL(fixtureUrl); wanted.hash = '';
  function matches(value) {
    try { const candidate = new URL(value); candidate.hash = ''; return candidate.href === wanted.href; }
    catch { return false; }
  }
  eventsOf(trace).forEach((event, eventIndex) => {
    const data = event.args?.data;
    const frames = event.name === 'TracingStartedInBrowser' ? data?.frames
      : event.name === 'FrameCommittedInBrowser' ? [data]
        : event.name === 'CommitLoad' ? [{ ...data, processId: event.pid }] : [];
    for (const frame of frames || []) {
      if (matches(frame?.url) && Number.isInteger(frame.processId)) {
        evidence.push({ eventIndex, name: event.name, processId: frame.processId, frame: frame.frame, url: frame.url });
      }
    }
  });
  return { rendererPids: [...new Set(evidence.map(item => item.processId))], evidence };
}

/** Use native marker timestamps, never buffered delivery order, as stage boundaries. */
export function partitionTrace(trace, { beforeStart, boundary, afterEnd }) {
  const events = eventsOf(trace);
  function marker(syncId) {
    const eventIndex = events.findIndex(event => (event.name === syncId && event.cat?.includes('blink.user_timing')) ||
      (event.name === 'clock_sync' && (event.args?.sync_id === syncId || event.args?.syncId === syncId)));
    const event = events[eventIndex];
    if (!Number.isFinite(event?.ts)) throw new Error(`Missing trace stage clock marker: ${syncId}`);
    return { syncId, eventIndex, ts: event.ts };
  }
  const first = marker(beforeStart), middle = marker(boundary), last = marker(afterEnd);
  if (!(first.ts < middle.ts && middle.ts < last.ts)) throw new Error('Trace stage clock markers are not ordered');
  return [
    { name: 'before', start: first, end: middle },
    { name: 'after', start: middle, end: last },
  ].map(stage => {
    const eventIndices = [];
    events.forEach((event, index) => {
      if (Number.isFinite(event.ts) && event.ts >= stage.start.ts && event.ts < stage.end.ts) eventIndices.push(index);
    });
    return { ...stage, eventIndices, events: eventIndices.map(index => events[index]) };
  });
}

export function loopbackUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('capturePaint only accepts trusted HTTP(S) loopback fixture URLs without credentials');
  }
  return url.href;
}

export async function settlePage(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error('Animation frames stalled')), 5000);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolveFrame(); }));
    });
  });
}

async function probeLifecycle(page, viewport, runId) {
  const steps = [];
  async function counter(expected, action) {
    const actual = await page.locator('#count').textContent();
    if (actual !== String(expected)) throw new Error(`Lifecycle ${action}: expected ${expected}, got ${actual}`);
    steps.push({ action, expected, actual, passed: true });
  }
  for (let index = 2; index <= 4; index++) {
    await page.locator('#increment').click();
    await settlePage(page);
    await counter(index, 'pointer');
  }
  await page.locator('#increment').focus();
  await page.keyboard.press('Enter');
  await settlePage(page);
  await counter(5, 'keyboard');
  await page.setViewportSize({ width: viewport.width, height: 480 });
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 160);
  await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 5000 });
  steps.push({ action: 'scroll', scrollY: await page.evaluate(() => window.scrollY), passed: true });
  await page.setViewportSize(viewport);
  await page.evaluate(id => sessionStorage.setItem('virtual-desktop-lifecycle', id), runId);
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await settlePage(page);
  await counter(0, 'reload');
  if (await page.evaluate(() => sessionStorage.getItem('virtual-desktop-lifecycle')) !== runId) {
    throw new Error('Lifecycle session storage did not survive reload');
  }
  steps.push({ action: 'session-storage-after-reload', passed: true });
  await page.locator('#increment').click();
  await settlePage(page);
  await counter(1, 'pointer-after-reload');
  return { passed: true, steps,
    scope: 'Real input, scroll, reload and session liveness only; scrolled/multi-layer visual replay is not validated' };
}

export async function recordTrace(cdp, action, { traceConfig = TRACE_CONFIG } = {}) {
  let tracing = false;
  try {
    await cdp.send('Tracing.start', {
      traceConfig,
      transferMode: 'ReturnAsStream', streamFormat: 'json',
    });
    tracing = true;
    let actionError;
    try { await action(); } catch (error) { actionError = error; }
    let timer;
    let completed;
    const completion = new Promise((resolveComplete, rejectComplete) => {
      completed = resolveComplete;
      cdp.once('Tracing.tracingComplete', completed);
      timer = setTimeout(() => rejectComplete(new Error('Timed out flushing Chromium trace')), 15000);
    });
    let finished;
    try {
      await cdp.send('Tracing.end');
      tracing = false;
      finished = await completion;
    } finally {
      clearTimeout(timer);
      cdp.off('Tracing.tracingComplete', completed);
    }
    if (actionError) throw actionError;
    if (!finished.stream) throw new Error('Chromium did not return a trace stream');
    const chunks = [];
    try {
      for (;;) {
        const chunk = await cdp.send('IO.read', { handle: finished.stream });
        chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data));
        if (chunk.eof) break;
      }
    } finally { await cdp.send('IO.close', { handle: finished.stream }); }
    const trace = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { events: eventsOf(trace),
      dataLossOccurred: typeof finished.dataLossOccurred === 'boolean' ? finished.dataLossOccurred : null };
  } finally {
    if (tracing) await cdp.send('Tracing.end').catch(() => {});
  }
}

/**
 * Capture before/after a real fixture button click using stock Chromium tracing.
 * No screenshot API, DOM reconstruction, or server-raster bypass is performed.
 */
export async function capturePaint({ url, executablePath, outputDir, viewport = { width: 960, height: 720 }, producerBufferBytes, remotePaint = false, noDisplay = false, lifecycle = false }) {
  const fixtureUrl = loopbackUrl(url);
  const producerArgs = producerLaunchArgs(producerBufferBytes);
  // CDP Browser.getBrowserCommandLine requires this explicit instrumentation
  // flag. Both default and enlarged-buffer runs use it for a comparable control.
  const launchArgs = captureLaunchArgs({ producerBufferBytes, remotePaint, noDisplay });
  if (typeof lifecycle !== 'boolean') throw new TypeError('lifecycle must be boolean');
  if (remotePaint && !executablePath) throw new TypeError('remotePaint requires an explicit patched executablePath');
  if (typeof outputDir !== 'string' || !outputDir) throw new TypeError('outputDir is required');
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 1 || viewport.height < 1) {
    throw new TypeError('viewport width and height must be positive integers');
  }
  const destination = resolve(outputDir);
  await mkdir(join(destination, 'pictures'), { recursive: true });
  const browser = await chromium.launch({ headless: true, args: launchArgs, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    // Attach after navigation: tracing's initial frame metadata must identify
    // the fixture renderer, rather than the about:blank renderer or browser UI.
    const response = await page.goto(fixtureUrl, { waitUntil: 'load', timeout: 30000 });
    if (!response?.ok()) throw new Error(`Fixture navigation failed: HTTP ${response?.status() ?? 'unknown'}`);
    loopbackUrl(page.url());
    await page.locator('#increment').waitFor({ state: 'visible' });
    await settlePage(page);
    const cdp = await context.newCDPSession(page);
    const version = await cdp.send('Browser.getVersion');
    const commandLine = await cdp.send('Browser.getBrowserCommandLine').catch(error => ({ error: error.message }));
    const browserInfo = { ...version, version: browser.version(), executablePath: executablePath || chromium.executablePath(),
      launchArgs, commandLine };
    const runId = randomUUID();
    const markers = { beforeStart: `${runId}:before-start`, boundary: `${runId}:after-start`, afterEnd: `${runId}:after-end` };
    let lifecycleResult = null;
    const traceResult = await recordTrace(cdp, async () => {
      await page.evaluate(name => { performance.mark(name); }, markers.beforeStart);
      // A genuine viewport invalidation records the already-loaded page after
      // tracing is enabled. It does not rebuild or mirror the page's DOM.
      await page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
      await settlePage(page);
      await page.setViewportSize(viewport);
      await settlePage(page);
      await page.evaluate(name => { performance.mark(name); }, markers.boundary);
      await page.locator('#increment').click();
      await settlePage(page);
      await page.evaluate(name => { performance.mark(name); }, markers.afterEnd);
      // Keep these observations in the trace, outside the two visual stages.
      // Test DOM reads never become replay content or replace a native SKP.
      if (lifecycle) lifecycleResult = await probeLifecycle(page, viewport, runId);
    });
    const traceEvents = traceResult.events;
    // Preserve diagnostics even if a browser omits a required clock marker.
    await writeFile(join(destination, 'trace.json'), JSON.stringify({ traceEvents, requestedStageMarkers: markers, dataLossOccurred: traceResult.dataLossOccurred }, null, 2));
    const stageTraces = partitionTrace(traceEvents, markers);
    const provenance = findPageProvenance(traceEvents, page.url());
    const traceStages = stageTraces.map(({ events, ...stage }) => ({ ...stage, eventCount: events.length }));
    await writeFile(join(destination, 'trace.json'), JSON.stringify({ traceEvents, captureStages: traceStages, dataLossOccurred: traceResult.dataLossOccurred }, null, 2));

    const latestPictures = new Map(), stages = [];
    for (let index = 0; index < stageTraces.length; index++) {
      const stage = stageTraces[index];
      const recordedPictures = [];
      const observedPictures = extractPictures(stage.events);
      const excludedPictures = [];
      for (const picture of observedPictures) {
        if (!provenance.rendererPids.includes(picture.event.pid)) {
          const { data, ...metadata } = picture;
          excludedPictures.push({ ...metadata, reason: 'Process is not identified as the fixture renderer' });
          continue;
        }
        const path = `pictures/${picture.sha256}.skp`;
        await writeFile(join(destination, path), picture.data);
        const { data, ...metadata } = picture;
        const recording = { ...metadata, path, traceEventIndex: stage.eventIndices[picture.eventIndex],
          layerEvidence: picture.layerEvidence ? { ...picture.layerEvidence,
            traceEventIndex: stage.eventIndices[picture.layerEvidence.eventIndex] } : null };
        recordedPictures.push(recording);
        // Some Chrome versions omit ids on snapshots. Only an explicit layer id
        // or an enclosing UpdateLayer slice can safely replace an older layer.
        if (picture.layerId != null) {
          const existing = latestPictures.get(picture.layerKey);
          if (!existing || picture.event.ts >= existing.event.ts) latestPictures.set(picture.layerKey, recording);
        }
      }
      stages.push({ name: stage.name, pictures: [...latestPictures.values()], recordedPictures, excludedPictures,
        observedPictureCount: observedPictures.length, trace: analyzeTrace(stage.events) });
    }
    const producerFeature = producerArgs[0]?.slice('--enable-features='.length);
    const manifest = {
      version: 1, capturedAt: new Date().toISOString(), url: fixtureUrl, browser: browserInfo, viewport,
      stages, provenance, remotePaintRequested: remotePaint, noDisplayRequested: noDisplay, lifecycle: lifecycleResult,
      captureStrategy: 'One continuous trace after fixture navigation; viewport width pulse forces baseline repaint; a real #increment click creates the after state. Native User Timing marks assign stages by renderer timestamps.',
      trace: { path: 'trace.json', categories: TRACE_CATEGORIES, config: TRACE_CONFIG,
        producerBuffer: { requestedBytes: producerBufferBytes ?? null, source: PRODUCER_BUFFER_SOURCE,
          launchArgumentObserved: Boolean(producerFeature && commandLine.arguments?.some(argument =>
            argument.startsWith('--enable-features=') && argument.slice('--enable-features='.length).split(',').includes(producerFeature))),
          effectiveBytes: null, explanation: 'Requested producer shared-memory capacity; actual allocation is not measured. Central trace-buffer size is configured separately.' },
        transport: 'ReturnAsStream', stages: traceStages, dataLossOccurred: traceResult.dataLossOccurred, ...analyzeTrace(traceEvents) },
      acceptance: {
        serverRasterBypassed: false,
        nativePicturesCaptured: stages.every(stage => stage.recordedPictures.length > 0 && stage.pictures.length > 0),
        traceComplete: traceResult.dataLossOccurred === false,
        explanation: remotePaint
          ? 'Experimental picture-layer mode requested. Engine trace, lifecycle and visual evidence must be assessed separately; the full server pixel-path gate remains unverified.'
          : 'Stock Chromium still runs its normal rendering pipeline. SKPs are debug exports of native paint records, not evidence of a raster bypass.',
        limitations: [
          'Trace event absence is not proof that raster or draw work was absent.',
          'Only pictures from renderer PIDs tied to the exact fixture URL by Chromium frame trace metadata are accepted. Browser UI pictures are excluded.',
          'Snapshots without a stable explicit or enclosing UpdateLayer id remain recorded diagnostics and are not stacked as independent layers.',
          'Layer records are debug artifacts, not a complete layer/property-tree or incremental resource protocol. Unchanged layers are carried into the after stage; layer removals are not reconciled.',
          'SKP and font/image serialization compatibility must be verified by actual client replay; captured bytes alone do not prove visual fidelity.',
        ],
      },
    };
    await writeFile(join(destination, 'capture.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally { await browser.close(); }
}
