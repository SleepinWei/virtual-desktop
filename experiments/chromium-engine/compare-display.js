import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createService } from '../../src/server.js';
import { WorkerClient } from '../../src/sessions.js';
import { verifiedEngine } from './verified.js';
import { browserProcessArgs } from './browser-runtime.js';
import { hostSample, selectProcessTree } from './load-guard.js';
import { nativeAllowedPaths } from './assets.js';
import { measureProcesses, percentile } from './site-metrics.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, canvaskit: { type: 'string' }, output: { type: 'string' },
  iterations: { type: 'string', default: '20' }, 'control-binary': { type: 'string' } } });
const iterations = Number(values.iterations);
if (!values.root || !values.canvaskit || !values.output || !Number.isInteger(iterations) || iterations < 8 || iterations > 20)
  throw new Error('Pass --root, --canvaskit, --output and 8..20 iterations; use the combined display watchdog');
const output = resolve(values.output), dataDir = await mkdtemp(join(tmpdir(), 'vd-display-'));
await mkdir(output, { recursive: true });
const viewport = { width: 960, height: 720 }, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', iterations, rounds: [], comparisons: [], errors: [],
  environment: { platform: process.platform, cpu: cpus()[0].model, cores: cpus().length, node: process.version }, viewport,
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: `${values['control-binary'] ? 'Installed Chrome screenshot control; pinned native execution and local viewer' : 'Same pinned Chromium for all modes'}, persistent local fixture, 2 warmups then ${iterations} paced increments, reverse run order, actual local NativeClient versus PNG/JPEG80 screenshot delivery.`,
  exclusions: ['Loopback HTTP payload bytes exclude headers/TCP/TLS and are not WAN bandwidth or latency.',
    'Action-to-present-ACK includes two viewer rAFs and an HTTP confirmation; it is not physical display scanout.',
    'Screenshot per action is not an optimized H264/WebRTC/CDP screencast or a complete OS VM.',
    'Native client rasterMs measures local CanvasKit paint, excluding asynchronous resource decode; client CPU covers the whole viewer tree.',
    'Summed process RSS double-counts shared pages; CPU sampling has coarse process-time resolution.',
    'Cold means new browser/context and empty browser cache, with an already installed engine and warm OS filesystem cache.',
    'Single active execution session; small local samples do not establish large-scale capacity or general website performance.'] };
const save = () => writeFile(join(output, 'display-report.json'), JSON.stringify(report, null, 2) + '\n');
const distribution = values => ({ p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) });
const delta = (end, start) => Object.fromEntries(Object.entries(end).map(([key, value]) => [key, value - (start[key] || 0)]));
const phaseSample = (sample, roots) => { const processes = selectProcessTree(sample.processes, roots); return { ...sample, processes,
  treeRssBytes: processes.reduce((sum, row) => sum + row.rss, 0) }; };
let service;
await save();

async function runMode(engine, mode, round, fixtureBase) {
  let worker, session, viewerServer, browser, front, page, interval, sampling = false, ended = false, lastIndex = -1, acknowledgements = 0;
  const samples = [], counters = { bootstrapBytes: 0, frameMetadataBytes: 0, frameResourceBytes: 0, screenshotBytes: 0, actionResponseBytes: 0, ackResponseBytes: 0, upstreamBodyBytes: 0 };
  const entry = { mode, round, status: 'running', sampleCount: iterations, minimumActionIntervalMs: 150 };
  report.rounds.push(entry); await save();
  const coldStart = performance.now(), before = await hostSample([process.pid]);
  const sample = () => hostSample([process.pid]);
  interval = setInterval(async () => {
    if (sampling || ended) return; sampling = true;
    try { samples.push(await sample()); } catch {} finally { sampling = false; }
  }, 250);
  try {
    let initialImage;
    if (mode === 'native-records') session = await service.manager.create({ backend: 'chromium', fixture: 'live' });
    else {
      worker = new WorkerClient(() => {}, { backend: 'traditional-benchmark' });
      const initial = await worker.call('init', { root: values.root, expectedArtifactsSha256: engine.artifactsSha256,
        expectedPatchSha256: engine.patchSha256, viewport, url: fixtureBase + '/live-fixture.html', allowedPaths: nativeAllowedPaths,
        imageFormat: mode === 'traditional-png' ? 'png' : 'jpeg',
        ...(values['control-binary'] ? { controlExecutablePath: resolve(values['control-binary']) } : {}) });
      initialImage = initial.png || initial.jpeg;
      entry.controlBrowserVersion = initial.browserVersion;
    }
    entry.producerReadyMs = performance.now() - coldStart;
    const category = path => path.startsWith('/native-runtime/') || path.endsWith('.js') ? 'bootstrapBytes'
      : path.includes('/resources/') ? 'frameResourceBytes' : path.includes('/stream?') ? 'frameMetadataBytes' : 'ackResponseBytes';
    const send = (response, bytes, type, key, headers = {}) => {
      counters[key] += bytes.length;
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); response.end(bytes);
    };
    front = http.createServer(async (request, response) => {
      try {
        check(/^(127\.0\.0\.1)(?::\d+)?$/.test(request.headers.host || ''), 'Loopback Host required');
        check(!request.headers.origin || request.headers.origin === 'http://' + request.headers.host, 'Same origin required');
        const path = request.url;
        if (request.method === 'GET' && path === '/') return send(response, await readFile(new URL('./display-benchmark.html', import.meta.url)), 'text/html', 'bootstrapBytes');
        if (request.method === 'GET' && path === '/benchmark-client.js') return send(response, await readFile(new URL('./display-benchmark-client.js', import.meta.url)), 'text/javascript', 'bootstrapBytes');
        if (request.method === 'GET' && path === '/benchmark-config') return send(response, Buffer.from(JSON.stringify({ mode, session })), 'application/json', 'bootstrapBytes');
        if (request.method === 'GET' && path === '/benchmark-image') return send(response, initialImage, mode === 'traditional-png' ? 'image/png' : 'image/jpeg', 'screenshotBytes');
        if (request.method === 'POST' && ['/benchmark-action', '/benchmark-presented'].includes(path)) {
          let body = ''; for await (const chunk of request) { body += chunk; check(body.length < 2048, 'Body limit'); counters.upstreamBodyBytes += chunk.length; }
          const input = JSON.parse(body);
          if (path === '/benchmark-presented') {
            check(input.initial === true || Number.isInteger(input.index) && input.index === lastIndex, 'Stale presentation ACK');
            if (!input.initial) acknowledgements++;
            return send(response, Buffer.from('{"accepted":true}'), 'application/json', 'ackResponseBytes');
          }
          check(Number.isInteger(input.index) && input.index === lastIndex + 1, 'Actions must be sequential and unique');
          const actionId = 'display-' + input.index, action = { type: 'click', selector: '#increment' }, start = performance.now();
          if (session) {
            const internal = service.manager.get(session.id), prior = internal.frames.revision;
            await service.manager.action(session.id, session.agentToken, { epoch: 1, actionId, action });
            const producerMs = performance.now() - start; lastIndex = input.index;
            return send(response, Buffer.from(JSON.stringify({ revision: internal.frames.revision, changed: internal.frames.revision > prior })),
              'application/json', 'actionResponseBytes', { 'X-Producer-Ms': String(producerMs) });
          }
          const result = await worker.call('action', { actionId, action }); lastIndex = input.index;
          return send(response, result.png || result.jpeg, mode === 'traditional-png' ? 'image/png' : 'image/jpeg', 'screenshotBytes',
            { 'X-Producer-Ms': String(performance.now() - start) });
        }
        // Stream the actual product assets/API unchanged; count bytes read from
        // each HTTP response rather than summing repeatedly referenced assets.
        const upstream = http.request(fixtureBase + path, { method: request.method, headers: request.headers }, incoming => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.on('data', chunk => { counters[category(path)] += chunk.length; });
          incoming.pipe(response); incoming.on('error', error => response.destroy(error));
          response.once('close', () => incoming.destroy());
        });
        upstream.on('error', error => response.destroy(error));
        request.on('data', chunk => { counters.upstreamBodyBytes += chunk.length; }); request.pipe(upstream);
      } catch (error) { response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end(error.message); }
    });
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + front.address().port;
    viewerServer = await chromium.launchServer({ executablePath: engine.binary, headless: true, args: browserProcessArgs(), timeout: 15000 });
    browser = await chromium.connect(viewerServer.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });
    page = await context.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base); await page.waitForFunction(() => window.displayBenchmark && document.documentElement.dataset.ready === 'true', undefined, { timeout: 20000 });
    entry.firstLocalPresentAckMs = performance.now() - coldStart; entry.coldHttpPayloadBytes = { ...counters };
    for (let index = 0; index < 2; index++) await page.evaluate(index => window.displayBenchmark.action(index), index);
    const owned = session ? service.manager.get(session.id).worker : worker;
    const roots = { server: [owned.child.pid], client: [viewerServer.process().pid] };
    const idleStart = await sample(); await delay(1000); const idleEnd = await sample();
    entry.idle = { server: measureProcesses(phaseSample(idleStart, roots.server), phaseSample(idleEnd, roots.server)),
      client: measureProcesses(phaseSample(idleStart, roots.client), phaseSample(idleEnd, roots.client)) };
    const start = await sample(), offset = samples.length, bytesBefore = { ...counters }, timings = [], began = performance.now();
    for (let index = 0; index < iterations; index++) {
      const actionStart = performance.now(); timings.push(await page.evaluate(index => window.displayBenchmark.action(index), index + 2));
      await delay(Math.max(0, 150 - (performance.now() - actionStart)));
    }
    const end = await sample(), elapsedMs = performance.now() - began, measured = samples.slice(offset);
    entry.elapsedMs = elapsedMs; entry.actionToPresentAckMs = distribution(timings.map(item => item.actionToPresentAckMs));
    entry.producerMs = distribution(timings.map(item => item.producerMs));
    entry.clientRasterMs = distribution(timings.map(item => item.rasterMs));
    entry.clientImageDecodeMs = session ? null : distribution(timings.map(item => item.imageDecodeMs));
    entry.httpPayloadBytes = delta(counters, bytesBefore); entry.timings = timings;
    entry.resources = Object.fromEntries(Object.entries(roots).map(([side, pids]) => [side, measureProcesses(phaseSample(start, pids), phaseSample(end, pids), measured.map(item => phaseSample(item, pids)))]));
    const gateway = sample => { const processes = sample.processes.filter(row => row.pid === process.pid); return { ...sample, processes,
      treeRssBytes: processes.reduce((sum, row) => sum + row.rss, 0) }; };
    entry.resources.gateway = measureProcesses(gateway(start), gateway(end), measured.map(gateway));
    entry.resources.combined = measureProcesses(start, end, measured);
    const observed = await owned.call('observe');
    entry.correctFinalState = new RegExp(`Increment\\s+${iterations + 2}\\b`).test(observed.text);
    check(entry.correctFinalState && acknowledgements === iterations + 2 && pageErrors.length === 0, 'Wrong final state, missing ACK or viewer error: ' + pageErrors.join('; '));
    check(timings.every(item => item.paintedFrames >= 1), 'An operation reused an old displayed frame');
    await writeFile(join(output, `${mode}-r${round}.png`), Buffer.from(await page.evaluate(() => window.displayBenchmark.png()), 'base64'));
    if (worker) {
      const reference = await worker.call('reference');
      await writeFile(join(output, `${mode}-reference-r${round}.png`), reference.png); entry.regions = reference.regions;
    }
    entry.coldResources = measureProcesses(before, end, samples);
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message.split('\n')[0]; throw error; }
  finally {
    ended = true; clearInterval(interval);
    await page?.evaluate(() => window.displayBenchmark?.stop()).catch(() => {});
    await browser?.close().catch(() => {}); await viewerServer?.close().catch(() => {});
    if (front) { front.closeAllConnections(); await new Promise(resolve => front.close(resolve)); }
    if (session && service.manager.get(session.id).state === 'ACTIVE') await service.manager.release(session.id, { save: false }).catch(() => {});
    await worker?.stop().catch(() => {}); await save();
  }
}

try {
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256 };
  report.control = { executablePath: values['control-binary'] ? resolve(values['control-binary']) : engine.binary,
    samePinnedBinary: !values['control-binary'], temporaryProfile: true };
  if (values['control-binary']) report.exclusions.push('Installed Chrome and native Chromium builds differ; observed control versions are recorded. Use the separate same-binary comparison to isolate the drawing path.');
  service = createService({ dataDir, adminToken: 'display-benchmark', maxActive: 1, maxStarting: 1,
    chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: 1 } });
  const base = await service.listen(0);
  for (let round = 0; round < 2; round++) {
    const modes = round === 0 ? ['traditional-png', 'traditional-jpeg', 'native-records'] : ['native-records', 'traditional-jpeg', 'traditional-png'];
    for (const mode of modes) { console.log(`Display round ${round}: ${mode}`); await runMode(engine, mode, round, base); }
  }
  const { comparePixels, crop, decoded } = await import('../chromium-paint/verify.js');
  for (let round = 0; round < 2; round++) {
    const native = report.rounds.find(item => item.round === round && item.mode === 'native-records');
    const actual = await decoded(await readFile(join(output, `native-records-r${round}.png`)));
    for (const mode of ['traditional-png', 'traditional-jpeg']) {
      const control = report.rounds.find(item => item.round === round && item.mode === mode);
      const expected = await decoded(await readFile(join(output, `${mode}-reference-r${round}.png`)));
      const displayed = await decoded(await readFile(join(output, `${mode}-r${round}.png`)));
      const visual = { native: { whole: comparePixels(expected, actual), regions: [] }, control: { whole: comparePixels(expected, displayed), regions: [] } };
      for (const { selector, bounds } of control.regions) for (const [name, pixels] of [['native', actual], ['control', displayed]])
        visual[name].regions.push({ selector, ...comparePixels(crop(expected, bounds), crop(pixels, bounds)) });
      const eligible = Object.values(visual).every(item => item.whole.passed && item.regions.every(region => region.passed));
      report.comparisons.push({ round, control: mode, eligible, visual,
        nativeOverControl: eligible ? { actionToPresentAckP95: native.actionToPresentAckMs.p95 / control.actionToPresentAckMs.p95,
          serverCpu: native.resources.server.processCpuSeconds / control.resources.server.processCpuSeconds,
          clientCpu: native.resources.client.processCpuSeconds / control.resources.client.processCpuSeconds,
          serverRss: native.resources.server.peakSummedRssBytes / control.resources.server.peakSummedRssBytes } : null });
    }
  }
  report.status = report.comparisons.filter(pair => pair.control === 'traditional-png').every(pair => pair.eligible)
    ? 'local-display-comparison-complete' : 'local-display-comparison-incomplete';
} catch (error) { report.status = 'local-display-comparison-failed'; report.errors.push(error.message.split('\n')[0]); }
finally { await service?.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ status: report.status, comparisons: report.comparisons.map(({ round, control, eligible }) => ({ round, control, eligible })), errors: report.errors }, null, 2));
process.exitCode = report.status === 'local-display-comparison-complete' ? 0 : 1;
