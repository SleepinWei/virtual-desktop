import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createService } from '../../src/server.js';
import { WorkerClient } from '../../src/sessions.js';
import { NativeFrames } from '../../src/native-frames.js';
import { verifiedEngine } from './verified.js';
import { nativeAllowedPaths } from './assets.js';
import { startLoadGuard, hostSample, SAFE_LIMITS } from './load-guard.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const check = (value, message) => { if (!value) throw new Error(message); };
const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, output: { type: 'string', default: 'test-results/chromium-bounded-load' },
  iterations: { type: 'string', default: '12' }, 'api-only': { type: 'boolean', default: false },
  'max-active': { type: 'string', default: '1' } } });
const iterations = Number(values.iterations);
check(Number.isInteger(iterations) && iterations >= 4 && iterations <= 20, 'Iterations must be 4–20');
const output = resolve(values.output); await mkdir(output, { recursive: true });
const apiOnly = values['api-only'], maxActive = Number(values['max-active']), apiActive = apiOnly ? 1 : maxActive;
check([1, 2].includes(maxActive), 'Maximum active browsers must be 1 or 2');
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing',
  environment: { platform: process.platform, cpu: cpus()[0].model, cores: cpus().length, node: process.version },
  limits: { ...SAFE_LIMITS, maxActiveBrowsers: apiActive, maxRequestBurst: 96, iterationsPerBrowser: iterations, recommendedNice: 10 },
  rounds: [], errors: [], scope: 'Bounded local producer benchmark. Same pinned Chromium, fixed fixture, per-session browser process. No claim about 100+ active sessions.',
  exclusions: ['Client raster/decode CPU and end-to-end viewer latency are not included.',
    'Transport bytes count producer payloads to the Node coordinator, not actual HTTP/TLS/compressed network bandwidth.',
    'RSS sums processes and double-counts shared pages; it is not unique physical memory.',
    'Conventional control captures one JPEG quality 80 per action; this is not an optimized video/screencast or pooled-browser baseline.',
    'Small sample, host has other applications running; do not extrapolate production capacity or general websites.'] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
await save();
let guard, service, temporary;
const running = new Set();
async function measurement(start, end, samples) {
  const baseline = new Map(start.processes.map(row => [row.pid, row.cpuSeconds]));
  const latest = new Map();
  for (const sample of [start, ...samples, end]) for (const row of sample.processes) latest.set(row.pid, Math.max(latest.get(row.pid) || 0, row.cpuSeconds));
  return { processCpuSeconds: [...latest].reduce((sum, [pid, seconds]) => sum + Math.max(0, seconds - (baseline.get(pid) || 0)), 0),
    peakSummedRssBytes: Math.max(...[start, ...samples, end].map(sample => sample.treeRssBytes)),
    maxProcessCount: Math.max(...[start, ...samples, end].map(sample => sample.processes.length)),
    minHostFreePercent: Math.min(...[start, ...samples, end].map(sample => sample.freePercent)),
    newHostSwapoutBytes: end.swapoutBytes - start.swapoutBytes };
}
try {
  guard = await startLoadGuard(); report.preflight = guard.baseline;
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256 };
  temporary = await mkdtemp(join(tmpdir(), 'vd-bounded-load-'));
  service = createService({ dataDir: temporary, adminToken: 'benchmark-local', maxActive: apiActive, maxStarting: 1,
    onWorker: worker => { guard.add(worker.child.pid); worker.exited.then(() => guard.remove(worker.child.pid)); },
    chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: apiActive } });
  const base = await service.listen(0), viewport = { width: 960, height: 720 };
  const parameters = { root: values.root, expectedArtifactsSha256: engine.artifactsSha256, expectedPatchSha256: engine.patchSha256,
    viewport, url: base + '/live-fixture.html', allowedPaths: nativeAllowedPaths };
  for (const active of apiOnly ? [] : Array.from({ length: maxActive }, (_, index) => index + 1)) for (const mode of ['native-records', 'traditional-jpeg']) {
    guard.check();
    console.log(`Starting ${mode}, ${active} active browser(s)`);
    const entries = [];
    try {
      for (let index = 0; index < active; index++) {
        const hub = new NativeFrames(() => ({ owner: 'agent', epoch: 1 }));
        const entry = { hub, payloadBytes: 0, metadataBytes: 0, frames: 0, faults: [], failed: false };
        entry.worker = new WorkerClient(() => { entry.failed = true; }, { backend: mode === 'native-records' ? 'chromium' : 'traditional-benchmark',
          onFrame: payload => { hub.ingest(payload); entry.frames++; entry.metadataBytes += Buffer.byteLength(JSON.stringify(payload.frame));
            entry.payloadBytes += payload.resources.reduce((sum, resource) => sum + resource.data.length, 0); },
          onFault: message => entry.faults.push(message) });
        running.add(entry.worker); guard.add(entry.worker.child.pid); entry.worker.exited.then(() => guard.remove(entry.worker.child.pid)); entries.push(entry);
        await entry.worker.call('init', parameters); guard.check();
        for (let warm = 0; warm < 2; warm++) await entry.worker.call('action', { actionId: `warm-${warm}`, action: { type: 'click', selector: '#increment' } });
      }
      const start = await hostSample([process.pid]), sampleIndex = guard.samples.length, startBytes = entries.map(entry => ({ bytes: entry.payloadBytes, metadata: entry.metadataBytes, frames: entry.frames }));
      const latency = [], loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
      const began = performance.now();
      await Promise.all(entries.map(async entry => {
        for (let index = 0; index < iterations; index++) {
          guard.check(); const before = performance.now();
          const result = await entry.worker.call('action', { actionId: `measured-${index}`, action: { type: 'click', selector: '#increment' } });
          if (result.jpeg) { entry.frames++; entry.payloadBytes += result.jpeg.length; }
          latency.push(performance.now() - before);
          check(!entry.failed && !entry.faults.length, 'Worker frame failure: ' + entry.faults.join(', '));
        }
      }));
      const elapsedMs = performance.now() - began; loop.disable();
      const end = await hostSample([process.pid]); guard.check();
      for (const entry of entries) check(new RegExp(`Increment\\s+${iterations + 2}\\b`).test((await entry.worker.call('observe')).text), 'Final page state differs');
      const measured = await measurement(start, end, guard.samples.slice(sampleIndex));
      check(loop.max / 1e6 < 250, 'Coordinator event loop exceeded 250 ms');
      report.rounds.push({ mode, active, operations: latency.length, elapsedMs, operationsPerSecond: latency.length / elapsedMs * 1000,
        latencyMs: { p50: percentile(latency, .5), p95: percentile(latency, .95), max: Math.max(...latency) },
        ...measured, maxCoordinatorLoopDelayMs: loop.max / 1e6,
        producerPayloadBytes: entries.reduce((sum, entry, index) => sum + entry.payloadBytes - startBytes[index].bytes, 0),
        producerMetadataBytes: entries.reduce((sum, entry, index) => sum + entry.metadataBytes - startBytes[index].metadata, 0),
        producedFrames: entries.reduce((sum, entry, index) => sum + entry.frames - startBytes[index].frames, 0), correctFinalState: true });
      await save();
    } finally { for (const entry of entries) { await entry.worker.stop(); running.delete(entry.worker); entry.hub.close(); } }
    await delay(1500); guard.check();
  }
  async function api(path, payload, credential = 'benchmark-local') {
    const response = await fetch(base + path, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }
  console.log('Checking bounded native admission and a 96-request action burst');
  const sessions = [];
  for (let index = 0; index < apiActive; index++) { const result = await api('/api/sessions', { backend: 'chromium' });
    check(result.status === 201, 'Admission session failed'); sessions.push(result.body); guard.check(); }
  try {
    const start = await hostSample([process.pid]), sampleIndex = guard.samples.length;
    const admission = await Promise.all(Array.from({ length: 16 }, () => api('/api/sessions', { backend: 'chromium' })));
    check(admission.every(result => result.status === 429 && result.body.error.code === 'NATIVE_SESSION_LIMIT'), 'Native cap admitted extra browsers');
    const session = sessions[0], times = [], began = performance.now();
    const results = await Promise.all(Array.from({ length: 96 }, async (_, index) => {
      const before = performance.now();
      const result = await api(`/api/sessions/${session.id}/actions`, { epoch: 1, actionId: `burst-${index}`, action: { type: 'click', selector: '#increment' } }, session.agentToken);
      times.push({ status: result.status, milliseconds: performance.now() - before }); return result;
    }));
    const elapsedMs = performance.now() - began, end = await hostSample([process.pid]); guard.check();
    const successful = results.filter(result => result.status === 200).length;
    report.burst = { requests: 96, accepted: successful, elapsedMs,
      statusCounts: Object.fromEntries([...new Set(results.map(result => result.status))].map(status => [status, results.filter(result => result.status === status).length])),
      unexpected: results.filter(result => result.status !== 200 && !(result.status === 429 && result.body.error?.code === 'COMMAND_QUEUE_FULL')).slice(0, 8),
      activeSlots: service.manager.stats().active, workerDiagnostics: service.manager.get(session.id).worker.diagnostics };
    await save();
    check(results.every(result => result.status === 200 || result.status === 429 && result.body.error.code === 'COMMAND_QUEUE_FULL'), 'Unexpected burst failure');
    const internal = service.manager.get(session.id), observed = await internal.worker.call('observe');
    check(new RegExp(`Increment\\s+${successful}\\b`).test(observed.text), 'Burst lost or duplicated an accepted action');
    report.burst = { ...report.burst, requestedSessions: 16, rejectedSessions: admission.length, maxActiveBrowsers: apiActive,
      requests: 96, accepted: successful, rejected: 96 - successful, elapsedMs,
      acceptedLatencyMs: { p50: percentile(times.filter(row => row.status === 200).map(row => row.milliseconds), .5),
        p95: percentile(times.filter(row => row.status === 200).map(row => row.milliseconds), .95) },
      ...await measurement(start, end, guard.samples.slice(sampleIndex)), correctFinalState: true };
  } finally { for (const session of sessions) await api(`/api/sessions/${session.id}/release`, { save: false }).catch(() => {}); }
  report.status = apiOnly ? 'bounded-api-burst-complete' : 'bounded-local-comparison-complete';
} catch (error) { report.errors.push(error.message); report.status = guard?.stopped ? 'safety-stopped' : 'failed'; }
finally {
  for (const worker of running) await worker.stop().catch(() => {});
  if (service) await service.close().catch(error => report.errors.push(error.message));
  if (guard) { report.safety = { stopped: guard.stopped, samples: guard.samples, baseline: guard.baseline }; await guard.close(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ status: report.status, rounds: report.rounds, burst: report.burst, errors: report.errors, output }, null, 2));
process.exitCode = ['bounded-local-comparison-complete', 'bounded-api-burst-complete'].includes(report.status) ? 0 : 1;
