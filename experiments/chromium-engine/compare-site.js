import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright';
import { verifiedEngine } from './verified.js';
import { ChromiumSession } from './session.js';
import { NativeFrames } from '../../src/native-frames.js';
import { allowedSiteRequest, externalSites } from './sites.js';
import { browserProcessArgs, imageAnimationArgs } from './browser-runtime.js';
import { browserAction } from './browser-actions.js';
import { hostSample } from './load-guard.js';
import { acceptedVisualStages, attachSiteAudit, comparablePair, measureProcesses, pageSnapshot, percentile, siteAction, siteWorkloads } from './site-metrics.js';
import { settlePage } from '../chromium-paint/capture.js';
import { createFrameLab } from '../chromium-paint/frame-server.js';
import { loadReplayRuntime, verifyRuntimeBuild } from '../chromium-paint/runtime.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, canvaskit: { type: 'string' }, output: { type: 'string' },
  site: { type: 'string' }, iterations: { type: 'string', default: '8' }, rounds: { type: 'string', default: '2' } } });
const iterations = Number(values.iterations), rounds = Number(values.rounds);
if (!values.root || !values.canvaskit || !values.output || !Object.hasOwn(siteWorkloads, values.site) ||
    !Number.isInteger(iterations) || iterations < 4 || iterations > 12 || ![1, 2].includes(rounds)) throw new Error('Use a configured workload, 4..12 iterations and 1..2 rounds');
const output = resolve(values.output), workload = siteWorkloads[values.site], policy = externalSites[values.site], viewport = { width: 960, height: 720 };
await mkdir(join(output, 'pictures'), { recursive: true });
await mkdir(join(output, 'fonts'), { recursive: true });
await mkdir(join(output, 'images'), { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', site: values.site, url: policy.url,
  gpuProcessMode: process.env.VIRTUAL_DESKTOP_MAC_GPU_MODE ?? 'separate', imageAnimationPolicy: policy.imageAnimationPolicy ?? 'static-only', viewport, workload, iterations, rounds: [], comparisons: [], visuals: [], errors: [],
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'Fresh unauthenticated real website, sequential ordinary JPEG80 and native-record producers. Local-only focus/search edits; no submission, login or video playback.',
  exclusions: ['Direct producer comparison, excluding gateway/worker IPC, client decode/raster and end-to-end network latency.',
    'JPEG80 is a screenshot-per-action control, not optimized video/screencast.',
    'Both modes share the same site HTTPS allowlist; failed/blocked resources are reported. This is not unrestricted arbitrary browsing.',
    'Live remote content can drift. Performance ratios require matching page text/state, fresh native frames, and strict replay validation.',
    'RSS sums shared pages repeatedly; CPU is process-time sampling. Small sequential samples do not establish capacity or unique physical-memory savings.',
    'CDP encodedResponseBytes covers observed page responses, not full TLS wire bytes; out-of-process iframe coverage is not guaranteed.',
    'Native raw SKP/metadata and deduplicated resource opportunities are not measured HTTP/TLS/compressed wire bandwidth.'] };
const save = () => writeFile(join(output, 'site-report.json'), JSON.stringify(report, null, 2) + '\n');
const manifest = { version: 1, viewport, stages: [] }, stored = new Set(); let storedBytes = 0;
const check = (ok, message) => { if (!ok) throw new Error(message); };
await save();

async function archive(hub, name, state) {
  check(hub.latest && !hub.fault, 'No complete native frame to archive: ' + hub.fault);
  const frame = structuredClone(hub.latest.frame);
  for (const resource of frame.resources) {
    if (stored.has(resource.id)) continue;
    const data = hub.resources.get(resource.id); check(data, 'Missing native archive resource');
    check(storedBytes + data.length <= 128 * 1024 ** 2, 'Site archive exceeds 128 MiB');
    if (Buffer.isBuffer(data)) await writeFile(join(output, resource.path), data);
    else await pipeline(data.stream(), createWriteStream(join(output, resource.path), { mode: 0o600 }));
    stored.add(resource.id); storedBytes += data.length;
  }
  manifest.stages.push({ name, frame, state });
  await writeFile(join(output, 'frame-capture.json'), JSON.stringify(manifest, null, 2));
}

async function runMode(engine, mode, round) {
  let server, browser, native, page, audit, busy = false, loop, lastJpeg;
  const hub = new NativeFrames(() => ({ owner: 'agent', epoch: 1 }));
  const samples = [], faults = [], seen = new Set();
  const produced = { frames: 0, resourceBytes: 0, metadataBytes: 0, uniqueResourceBytes: 0, ipcBufferBytes: 0, referencedFontBytes: 0, referencedImageBytes: 0 };
  const start = await hostSample([process.pid]);
  const interval = setInterval(async () => {
    if (busy) return; busy = true;
    try { samples.push(await hostSample([process.pid])); } catch {} finally { busy = false; }
  }, 500);
  const began = performance.now(), entry = { mode, round, status: 'running', gpuProcessMode: report.gpuProcessMode };
  report.rounds.push(entry); await save();
  try {
    if (mode === 'native-records') {
      native = new ChromiumSession({
        onFrame(payload) {
          try {
            hub.ingest(payload); produced.frames++; produced.metadataBytes += Buffer.byteLength(JSON.stringify(payload.frame));
            for (const resource of payload.frame.resources) {
              produced.resourceBytes += resource.bytes;
              if (resource.kind === 'font') produced.referencedFontBytes += resource.bytes;
              else if (resource.kind === 'image') produced.referencedImageBytes += resource.bytes;
              else produced.ipcBufferBytes += resource.bytes;
              if (!seen.has(resource.id)) { seen.add(resource.id); produced.uniqueResourceBytes += resource.bytes; }
            }
          } catch (error) { faults.push(error.message); hub.unsupported(error.message); }
        },
        onFault(message) { faults.push(message); hub.unsupported(message); }, onBrowser() {},
        async onPage(current, cdp) { page = current; audit = await attachSiteAudit(current, cdp); },
      });
      await native.start({ root: values.root, expectedArtifactsSha256: engine.artifactsSha256, expectedPatchSha256: engine.patchSha256,
        url: policy.url, site: values.site, viewport, allowedPaths: [] });
      check(native.gpuProcessMode === report.gpuProcessMode, 'Actual native GPU mode differs');
    } else {
      server = await chromium.launchServer({ executablePath: engine.binary, headless: true, chromiumSandbox: false,
        host: '127.0.0.1', timeout: 15000, args: ['--enable-automation', ...browserProcessArgs(), ...imageAnimationArgs(policy.imageAnimationPolicy)] });
      browser = await chromium.connect(server.wsEndpoint());
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' });
      await context.route('**/*', route => {
        const request = route.request();
        return allowedSiteRequest(values.site, request.url(), { navigation: request.isNavigationRequest(), method: request.method() }) ? route.continue() : route.abort('blockedbyclient');
      });
      page = await context.newPage();
      context.on('page', other => { if (other !== page) other.close().catch(() => {}); });
      const cdp = await context.newCDPSession(page); audit = await attachSiteAudit(page, cdp);
      const command = await browser.newBrowserCDPSession();
      try {
        const result = await command.send('Browser.getBrowserCommandLine');
        check((result.arguments.includes('--in-process-gpu') ? 'in-process' : 'separate') === report.gpuProcessMode, 'Actual ordinary GPU mode differs');
      } finally { await command.detach(); }
      const response = await page.goto(policy.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      entry.httpStatus = response?.status(); check(response?.ok(), 'Ordinary navigation failed: HTTP ' + response?.status());
      await page.waitForTimeout(750); await settlePage(page);
      lastJpeg = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000 });
      entry.firstJpegBytes = lastJpeg.length;
    }
    const readyMs = performance.now() - began, ready = await hostSample([process.pid]);
    entry.startup = { readyMs, ...measureProcesses(start, ready, samples) };
    entry.initialState = await pageSnapshot(page, workload);
    check(entry.initialState.textLength >= 40 && allowedSiteRequest(values.site, entry.initialState.url, { navigation: true }), 'No supported public content loaded');
    if (workload.kind === 'input') check(entry.initialState.target?.tag === 'input', 'Configured search input missing');
    if (native) await archive(hub, `r${round}-before`, entry.initialState);
    else {
      await writeFile(join(output, `ordinary-r${round}-before.jpg`), lastJpeg);
      await page.screenshot({ path: join(output, `ordinary-r${round}-before.png`), timeout: 5000 });
    }
    async function action(index) {
      check(!faults.length && (!native || !hub.fault), 'Native producer fault: ' + faults.join('; '));
      const operation = siteAction(workload, index), before = performance.now();
      const result = native ? await native.action({ actionId: 'site-' + index, action: operation }) : null;
      if (!native) { await browserAction(page, viewport, operation); await settlePage(page); }
      const jpeg = native ? null : await page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000 });
      if (jpeg) lastJpeg = jpeg;
      const elapsedMs = performance.now() - before;
      const state = await pageSnapshot(page, workload);
      check(workload.kind !== 'input' || state.target?.value === operation.value, 'Input postcondition differs');
      check(!native || hub.latest && !hub.fault && !faults.length, 'Action left no supported native frame');
      return { elapsedMs, jpegBytes: jpeg?.length ?? 0, nativeFrameChanged: native ? !result.unchanged : null, state };
    }
    // Warmups use unique action IDs and the measured window restarts at 2.
    await action(0); await action(1);
    const baseline = await hostSample([process.pid]), offset = samples.length, counters = { ...produced };
    const operations = []; loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
    const actionStart = performance.now();
    for (let index = 0; index < iterations; index++) operations.push(await action(index + 2));
    const elapsedMs = performance.now() - actionStart; loop.disable();
    const end = await hostSample([process.pid]);
    entry.operations = operations.length; entry.elapsedMs = elapsedMs; entry.operationsPerSecond = operations.length / elapsedMs * 1000;
    entry.latencyMs = { p50: percentile(operations.map(item => item.elapsedMs), .5), p95: percentile(operations.map(item => item.elapsedMs), .95), max: Math.max(...operations.map(item => item.elapsedMs)) };
    entry.operationTimingsMs = operations.map(item => item.elapsedMs);
    entry.measurement = measureProcesses(baseline, end, samples.slice(offset));
    entry.maxCoordinatorLoopDelayMs = loop.max / 1e6;
    entry.freshNativeFrames = native ? operations.filter(item => item.nativeFrameChanged).length : null;
    entry.producer = native ? Object.fromEntries(Object.keys(produced).map(key => [key, produced[key] - counters[key]])) :
      { frames: operations.length, jpegBytes: operations.reduce((sum, item) => sum + item.jpegBytes, 0) };
    entry.finalState = operations.at(-1).state;
    check(entry.maxCoordinatorLoopDelayMs < 250, 'Coordinator responsiveness exceeded 250 ms');
    if (native) await archive(hub, `r${round}-after`, entry.finalState);
    else {
      await writeFile(join(output, `ordinary-r${round}-after.jpg`), lastJpeg);
      await page.screenshot({ path: join(output, `ordinary-r${round}-after.png`), timeout: 5000 });
    }
    entry.status = 'passed';
  } catch (error) {
    entry.status = 'failed'; entry.error = error.message.split('\n')[0];
    entry.failureElapsedMs = performance.now() - began;
    try { entry.resourcesUntilFailure = measureProcesses(start, await hostSample([process.pid]), samples); } catch {}
    if (page && !page.isClosed()) {
      let timer;
      try { entry.partialPageState = await Promise.race([pageSnapshot(page, workload),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Partial state timeout')), 1000); })]); }
      catch {} finally { clearTimeout(timer); }
    }
    if (native) entry.nativeStartup = { gpuProcessMode: native.gpuProcessMode, frames: native.frames, rendererPid: native.rendererPid,
      stream: native.stream?.stats, lastFault: native.lastFault, provenance: native.startupProvenance,
      candidates: [...native.candidates.values()].map(message => ({ pid: message.pid, error: message.error, treeId: message.snapshot?.tree_id,
        viewport: message.snapshot?.viewport, layers: message.snapshot?.layers?.length })) };
  }
  finally {
    clearInterval(interval); loop?.disable(); entry.network = audit; entry.faults = faults.slice(0, 8);
    await native?.close().catch(() => {}); await browser?.close().catch(() => {}); await server?.close().catch(() => {}); hub.close();
    await save();
  }
  return entry;
}

async function replay(engine) {
  // Native pixel-reference libraries are needed only after both producers
  // exit. Keep their resident memory out of the producer measurement window.
  const { comparePixels, crop, decoded } = await import('../chromium-paint/verify.js');
  let lab, server, browser;
  try {
    lab = createFrameLab({ outputDir: output, canvasKitDirectory: values.canvaskit }); const base = await lab.listen();
    server = await chromium.launchServer({ executablePath: engine.binary, headless: true, args: ['--enable-automation', ...browserProcessArgs(), ...imageAnimationArgs(policy.imageAnimationPolicy)], timeout: 15000 });
    browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 1180, height: 1100 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); await page.goto(base);
    for (let index = 0; index < manifest.stages.length; index++) {
      const stage = manifest.stages[index], item = { stage: stage.name, passed: false };
      report.visuals.push(item);
      try {
        if (index) await page.locator('#stage').selectOption(stage.name);
        await page.waitForFunction(name => document.documentElement.dataset.status === 'unsupported' ||
          document.documentElement.dataset.status === 'ready' && document.querySelector('#skp').dataset.stage === name, stage.name, { timeout: 20000 });
        const details = JSON.parse(await page.locator('#result').textContent());
        check(await page.locator('html').getAttribute('data-status') === 'ready', details.error || 'Native replay failed');
        check(details.frameId === stage.frame.id && details.channel.pending === 0, 'Replay frame/ACK mismatch');
        const bytes = Buffer.from((await page.locator('#skp').evaluate(canvas => canvas.toDataURL('image/png'))).split(',')[1], 'base64');
        await writeFile(join(output, `client-${stage.name}.png`), bytes);
        const expected = await decoded(await readFile(join(output, `ordinary-${stage.name}.png`))), actual = await decoded(bytes);
        const control = await decoded(await readFile(join(output, `ordinary-${stage.name}.jpg`)));
        item.controlJpegQuality = { wholeImage: comparePixels(expected, control), regions: [] };
        item.wholeImage = comparePixels(expected, actual); item.regions = [];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
          const bounds = { x: x * 320, y: y * 240, width: 320, height: 240 };
          item.regions.push({ bounds, ...comparePixels(crop(expected, bounds), crop(actual, bounds)) });
          item.controlJpegQuality.regions.push({ bounds, ...comparePixels(crop(expected, bounds), crop(control, bounds)) });
        }
        const ordinary = report.rounds.find(r => r.mode === 'traditional-jpeg' && stage.name.startsWith(`r${r.round}-`));
        const state = stage.name.endsWith('before') ? ordinary?.initialState : ordinary?.finalState;
        item.sameTextAndState = state?.textSha256 === stage.state.textSha256 && state?.target?.value === stage.state.target?.value && state?.scroll.y === stage.state.scroll.y;
        item.decodedAndAcked = true; item.passed = item.sameTextAndState && item.wholeImage.passed && item.regions.every(region => region.passed);
        item.controlJpegQuality.passed = item.controlJpegQuality.wholeImage.passed && item.controlJpegQuality.regions.every(region => region.passed);
      } catch (error) { item.error = error.message.split('\n')[0]; }
      await save();
    }
  } finally { await browser?.close().catch(() => {}); await server?.close().catch(() => {}); await lab?.close(); }
}

try {
  const engine = await verifiedEngine(values.root, { requireStream: true });
  const runtime = await loadReplayRuntime(values.canvaskit); await verifyRuntimeBuild(runtime, values.canvaskit, values.root, engine.source);
  report.build = { revision: engine.source.revision, binarySha256: engine.state.binarySha256, artifactsSha256: engine.artifactsSha256, patchSha256: engine.patchSha256 };
  for (let round = 0; round < rounds; round++) {
    const roundStart = report.rounds.length;
    const modes = round % 2 ? ['native-records', 'traditional-jpeg'] : ['traditional-jpeg', 'native-records'];
    for (const mode of modes) {
      report.phase = `round-${round}-${mode}`; await save();
      await runMode(engine, mode, round);
    }
    if (report.rounds.slice(roundStart).some(entry => entry.status !== 'passed')) break;
  }
  if (manifest.stages.length) { report.phase = 'offline-replay-after-producers-closed'; await save(); await replay(engine); }
  for (let round = 0; round < rounds; round++) {
    const ordinary = report.rounds.find(r => r.round === round && r.mode === 'traditional-jpeg'), native = report.rounds.find(r => r.round === round && r.mode === 'native-records');
    const visuals = report.visuals.filter(item => item.stage.startsWith(`r${round}-`));
    const eligible = comparablePair(ordinary, native) && acceptedVisualStages(visuals);
    report.comparisons.push({ round, eligible, reason: eligible ? null : 'Both producers, equal state, fresh native frames, native replay and JPEG80 control must pass the strict visual stages',
      nativeOverOrdinary: eligible ? { actionP95: native.latencyMs.p95 / ordinary.latencyMs.p95,
        startupReady: native.startup.readyMs / ordinary.startup.readyMs,
        actionCpu: ordinary.measurement.processCpuSeconds > 0 ? native.measurement.processCpuSeconds / ordinary.measurement.processCpuSeconds : null,
        peakSummedRss: native.measurement.peakSummedRssBytes / ordinary.measurement.peakSummedRssBytes } : null });
  }
  report.archive = { stages: manifest.stages.length, resources: stored.size, bytes: storedBytes };
  report.status = report.comparisons.every(pair => pair.eligible) ? 'public-site-comparison-complete' : 'public-site-comparison-incomplete';
} catch (error) { report.status = 'public-site-comparison-failed'; report.errors.push(error.message.split('\n')[0]); }
finally { report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ status: report.status, site: report.site, comparisons: report.comparisons, errors: report.errors }, null, 2));
process.exitCode = report.status === 'public-site-comparison-complete' ? 0 : 1;
