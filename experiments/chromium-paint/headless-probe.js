import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const TIMEOUT = 10000;
const START = 'headless-probe:no-display:start';
const END = 'headless-probe:no-display:end';
const CATEGORIES = [
  'toplevel', 'cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.layers',
  'disabled-by-default-devtools.timeline.picture', 'disabled-by-default-cc.debug.picture',
].join(',');
const SOURCES = [
  'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl',
  'https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/HeadlessExperimental.pdl',
  'https://raw.githubusercontent.com/chromium/chromium/main/headless/lib/browser/protocol/target_handler.cc',
  'https://raw.githubusercontent.com/chromium/chromium/main/headless/lib/browser/protocol/headless_handler.cc',
  'https://raw.githubusercontent.com/chromium/chromium/main/cc/paint/display_item_list.cc',
  'https://raw.githubusercontent.com/chromium/chromium/main/cc/tiles/tile_manager.cc',
];

function bounded(promise, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} timed out after ${TIMEOUT} ms`)), TIMEOUT);
  })]).finally(() => clearTimeout(timer));
}

// A browser CDPSession cannot address an arbitrary flattened target session.
// Use the documented non-flattened CDP transport for this isolated target.
async function targetSession(root, targetId) {
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: false });
  const events = new EventEmitter(), pending = new Map();
  let sequence = 0;
  const received = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (!message.id) { events.emit(message.method, message.params); return; }
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id); clearTimeout(operation.timer);
    if (message.error) operation.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else operation.resolve(message.result);
  };
  root.on('Target.receivedMessageFromTarget', received);
  return {
    on: (name, listener) => events.on(name, listener),
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const fail = error => {
          const item = pending.get(id);
          if (!item) return;
          clearTimeout(item.timer); pending.delete(id); reject(error);
        };
        const timer = setTimeout(() => fail(new Error(`${method} timed out after ${TIMEOUT} ms`)), TIMEOUT);
        pending.set(id, { resolve, reject, timer });
        root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(fail);
      });
    },
    dispose() {
      root.off('Target.receivedMessageFromTarget', received);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Probe target session closed')); }
      pending.clear();
    },
  };
}

export function extractHeadlessPictures(events) {
  const pictures = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'skp64' && typeof child === 'string') {
        const bytes = Buffer.from(child, 'base64');
        // Validate the SKP signature, not merely the presence of a base64 string.
        if (bytes.length > 8 && bytes.subarray(0, 8).toString('ascii') === 'skiapict') {
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          pictures.set(sha256, { sha256, byteLength: bytes.length, bytes });
        }
      } else visit(child);
    }
  };
  for (const event of events) visit(event.args);
  return [...pictures.values()];
}

export function analyzeHeadlessTrace(events, { apiSupported = true, traceComplete = true } = {}) {
  const start = events.find(event => event.name === START && Number.isFinite(event.ts));
  const end = events.find(event => event.name === END && Number.isFinite(event.ts) && event.ts > (start?.ts ?? Infinity));
  const measured = start && end ? events.filter(event => Number.isFinite(event.ts) && event.ts >= start.ts && event.ts <= end.ts) : [];
  const raster = event => /(?:Raster(?:izer)?Task|RasterBufferProvider::Playback)/.test(event.name || '') && ['X', 'B', 'b'].includes(event.ph);
  const phaseRaster = measured.filter(raster), allRaster = events.filter(raster);
  const phasePictures = extractHeadlessPictures(measured), allPictures = extractHeadlessPictures(events);
  const coverage = Boolean(traceComplete && start && end);
  let status = 'candidate-unverified';
  if (!apiSupported) status = 'unsupported';
  else if (!coverage) status = 'insufficient-trace';
  else if (phaseRaster.length) status = 'raster-observed';
  else if (!phasePictures.length) status = 'no-paint-record';
  return {
    status, gatePassed: false,
    reason: status === 'candidate-unverified'
      ? 'A bounded no-display interval contains SKP data and no observed raster tasks; this is not proof of a bypassed pixel path.'
      : 'No verified engine bypass: unsupported APIs, missing trace/paint evidence, or observed raster work fail closed.',
    measurement: { complete: coverage, rendererPid: start?.pid ?? null,
      startTs: start?.ts ?? null, endTs: end?.ts ?? null,
      durationMicroseconds: coverage ? end.ts - start.ts : null },
    raster: { measured: phaseRaster.length, entireTrace: allRaster.length,
      measuredEvents: phaseRaster.slice(0, 30).map(({ name, pid, tid, ts, dur }) => ({ name, pid, tid, ts, dur })) },
    pictures: { measured: phasePictures.length, entireTrace: allPictures.length },
  };
}

export function trustedHeadlessProbeUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Headless probe requires a trusted HTTP(S) loopback fixture URL without credentials');
  }
  return url.href;
}

export async function runHeadlessProbe({ url, outputDir, executablePath = process.env.HEADLESS_SHELL_EXECUTABLE_PATH } = {}) {
  const fixtureUrl = trustedHeadlessProbeUrl(url);
  if (!outputDir) throw new Error('outputDir is required');
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 1, experiment: 'headless-no-display-updates', gatePassed: false,
    status: 'initializing', url: fixtureUrl, platform: process.platform, arch: process.arch,
    executablePath: executablePath || null, needsBinary: false, fallback: 'none',
    launchArgs: ['--run-all-compositor-stages-before-draw'],
    requested: { enableBeginFrameControl: true, noDisplayUpdates: true, screenshotRequested: false },
    apiSupported: false, browser: null, navigation: null, beginFrames: [], layerSnapshots: [], diagnostics: [], commands: [],
    sources: SOURCES,
    limitations: [
      'The API is documented as unsupported on macOS; this probe attempts it without falling back to an uncontrolled target.',
      'The measured mutation is a probe-owned DOM rectangle; it is actual Blink execution, not a reconstructed display list.',
      'LayerTree inspection follows the measured interval and may force document lifecycle work; its output is reported separately.',
      'No raster events can also mean no paint or inadequate trace coverage. This experiment never passes the engine bypass gate.',
      'SkPicture header validation does not prove successful deserialization, font/image completeness, or client visual fidelity.',
    ],
  };
  let browser, root, target, stage = 'launch', tracing = false, traceComplete = false;
  const traceEvents = [], completed = Promise.withResolvers();
  const call = async (session, method, params = {}) => {
    stage = method;
    const entry = { method, params };
    report.commands.push(entry);
    try { const result = await bounded(session.send(method, params), method); entry.ok = true; return result; }
    catch (error) { entry.ok = false; entry.error = { message: error.message, code: error.code ?? null }; throw error; }
  };
  const evaluate = async expression => {
    const result = await call(target, 'Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Probe expression failed');
    return result.result.value;
  };
  try {
    stage = 'binary-selection';
    if (typeof executablePath !== 'string' || !executablePath.trim()) {
      throw Object.assign(new Error('A dedicated headless-shell binary is required. Pass executablePath or set HEADLESS_SHELL_EXECUTABLE_PATH; no stock-Chrome fallback is used.'), { code: 'HEADLESS_BINARY_REQUIRED' });
    }
    await access(executablePath);
    stage = 'launch';
    browser = await chromium.launch({ executablePath, headless: true, args: report.launchArgs, timeout: TIMEOUT });
    root = await browser.newBrowserCDPSession();
    report.browser = await call(root, 'Browser.getVersion');
    root.on('Tracing.dataCollected', event => traceEvents.push(...event.value));
    root.on('Tracing.tracingComplete', () => { traceComplete = true; completed.resolve(); });
    try {
      await call(root, 'Tracing.start', { categories: CATEGORIES, transferMode: 'ReportEvents' });
      tracing = true;
    } catch (error) { report.diagnostics.push({ stage: 'Tracing.start', error: error.message }); }
    const context = await call(root, 'Target.createBrowserContext', { disposeOnDetach: true });
    const created = await call(root, 'Target.createTarget', {
      url: 'about:blank', width: 960, height: 720, browserContextId: context.browserContextId, enableBeginFrameControl: true,
    });
    report.targetId = created.targetId;
    target = await targetSession(root, created.targetId);
    await call(target, 'Page.enable');
    await call(target, 'Runtime.enable');
    const begin = async () => {
      const result = await call(target, 'HeadlessExperimental.beginFrame', { noDisplayUpdates: true, interval: 1000 / 60 });
      if ('screenshotData' in result) throw new Error('Unexpected pixel payload returned without a screenshot request');
      report.apiSupported = true;
      report.beginFrames.push(result);
    };
    const navigation = await call(target, 'Page.navigate', { url: fixtureUrl });
    if (navigation.errorText) throw new Error(navigation.errorText);
    for (let attempt = 0; attempt < 20; attempt++) {
      await begin();
      report.navigation = await evaluate('({url:location.href, title:document.title, readyState:document.readyState, hasBody:!!document.body})');
      if (report.navigation.url !== 'about:blank' && report.navigation.readyState === 'complete' && report.navigation.hasBody) {
        trustedHeadlessProbeUrl(report.navigation.url);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (report.navigation?.url === 'about:blank' || report.navigation?.readyState !== 'complete' || !report.navigation.hasBody) throw new Error('Fixture did not finish loading under controlled frames');
    await evaluate(`performance.mark(${JSON.stringify(START)}); true`);
    await evaluate(`(() => { const element = document.createElement('div'); element.id = '__headless_paint_probe__';
      element.style.cssText = 'position:fixed;left:12px;top:12px;width:120px;height:80px;background:#2463eb;z-index:2147483647';
      document.body.append(element); return element.getBoundingClientRect().width; })()`);
    for (let index = 0; index < 4; index++) {
      await evaluate(`document.getElementById('__headless_paint_probe__').style.backgroundColor = ${JSON.stringify(index % 2 ? '#2463eb' : '#20a060')}; true`);
      await begin();
    }
    await evaluate(`performance.mark(${JSON.stringify(END)}); true`);
    let layers = [];
    target.on('LayerTree.layerTreeDidChange', event => { layers = event.layers || []; });
    try {
      await call(target, 'LayerTree.enable');
      await begin();
      for (const layer of layers.filter(layer => layer.drawsContent).slice(0, 8)) {
        try {
          const { snapshotId } = await call(target, 'LayerTree.makeSnapshot', { layerId: layer.layerId });
          try {
            const { commandLog } = await call(target, 'LayerTree.snapshotCommandLog', { snapshotId });
            const filename = `headless-command-log-${layer.layerId}.json`;
            await writeFile(join(directory, filename), JSON.stringify(commandLog, null, 2));
            report.layerSnapshots.push({ layerId: layer.layerId, commandCount: commandLog.length, commandLogFile: filename,
              replayable: false, reason: 'Debug command logs omit text blobs and image resource bytes.' });
          } finally { await call(target, 'LayerTree.releaseSnapshot', { snapshotId }); }
        } catch (error) { report.diagnostics.push({ stage: 'LayerTree.makeSnapshot', layerId: layer.layerId, error: error.message }); }
      }
      report.layerCount = layers.length;
    } catch (error) { report.diagnostics.push({ stage: 'LayerTree.enable', error: error.message }); }
  } catch (error) {
    report.failure = { stage, message: error.message, code: error.code ?? null };
    report.needsBinary = stage === 'binary-selection';
    report.status = report.needsBinary || /not supported|not found|wasn't found|unknown method|not available/i.test(error.message) ? 'unsupported' : 'failed';
  } finally {
    if (tracing) {
      try { await call(root, 'Tracing.end'); await bounded(completed.promise, 'Tracing.tracingComplete'); }
      catch (error) { report.diagnostics.push({ stage: 'Tracing.end', error: error.message }); }
    }
    target?.dispose();
    if (browser) {
      try { await bounded(browser.close(), 'Browser.close'); }
      catch (error) { report.diagnostics.push({ stage: 'Browser.close', error: error.message }); }
    }
  }
  report.analysis = analyzeHeadlessTrace(traceEvents, { apiSupported: report.apiSupported, traceComplete });
  if (!report.failure) report.status = report.analysis.status;
  const pictures = extractHeadlessPictures(traceEvents);
  report.pictureFiles = [];
  for (const picture of pictures) {
    const filename = `headless-${picture.sha256.slice(0, 16)}.skp`;
    await writeFile(join(directory, filename), picture.bytes);
    report.pictureFiles.push({ file: filename, sha256: picture.sha256, byteLength: picture.byteLength });
  }
  report.trace = { complete: traceComplete, eventCount: traceEvents.length, file: 'headless-trace.json' };
  await writeFile(join(directory, report.trace.file), JSON.stringify({ traceEvents }));
  await writeFile(join(directory, 'headless-report.json'), JSON.stringify(report, null, 2));
  return report;
}
