import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { createService } from '../src/server.js';
import { AgentClient } from '../src/client.js';

const count = Number(process.env.BENCH_SESSIONS || 8), iterations = Number(process.env.BENCH_ITERATIONS || 20);
if (!Number.isInteger(count) || count < 1 || count > 32 || !Number.isInteger(iterations) || iterations < 1 || iterations > 200) throw new Error('Use 1–32 sessions and 1–200 iterations');
const dataDir = await mkdtemp(join(process.cwd(), '.benchmark-data-'));
const service = createService({ dataDir, maxActive: count, maxQueued: count, maxStarting: 2 });
const url = await service.listen(0);
const samples = { createMs: [], actionMs: [], snapshotBytes: [], deltaBytes: [], maxRssKiB: [], currentRssBytes: [] };
function summary(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  return { samples: numbers.length, min: sorted[0], mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
try {
  const wallStart = performance.now();
  const sessions = await Promise.all(Array.from({ length: count }, async () => {
    const start = performance.now();
    const response = await fetch(url + '/api/sessions', { method: 'POST', headers: { Authorization: 'Bearer dev-local', 'Content-Type': 'application/json' }, body: '{}' });
    const s = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(s));
    samples.createMs.push(performance.now() - start);
    return s;
  }));
  await Promise.all(sessions.map(async s => {
    const agent = new AgentClient(url, s);
    const framePath = `${url}/api/sessions/${s.id}/frame`;
    const frameOptions = { headers: { Authorization: `Bearer ${s.viewerToken}` } };
    samples.snapshotBytes.push(Buffer.byteLength(await (await fetch(framePath, frameOptions)).text()));
    let seq = 1;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const result = await agent.click('#increment');
      samples.actionMs.push(performance.now() - start);
      samples.deltaBytes.push(Buffer.byteLength(await (await fetch(`${framePath}?since=${seq}`, frameOptions)).text()));
      seq = result.seq;
    }
    const metrics = await (await fetch(`${url}/api/sessions/${s.id}/metrics`, { headers: { Authorization: 'Bearer dev-local' } })).json();
    samples.maxRssKiB.push(metrics.maxRssKiB);
    if (Number.isFinite(metrics.memory.rss)) samples.currentRssBytes.push(metrics.memory.rss);
  }));
  let cpuModel = 'unavailable';
  try { cpuModel = os.cpus()[0]?.model || 'unavailable'; } catch {}
  const result = {
    label: 'Restricted trusted demo protocol PoC; not real-website browser capacity', recordedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch, cpuModel },
    workload: { sessions: count, actionsPerSession: iterations, maxConcurrentStarts: 2, viewerAttached: false, measureIncludesHttpIpcAndLayout: true },
    wallTimeMs: performance.now() - wallStart,
    results: Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, summary(value)])),
    limitations: ['maxRssKiB is per-worker lifetime peak; do not sum peaks as simultaneous measured RSS', 'Current RSS may be unavailable in restricted environments', 'Bytes are JSON response bodies; HTTP/TLS, website traffic, viewer client work and compression excluded', 'No Chromium, real websites or hostile-tenant security isolation in this benchmark'],
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/benchmark.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
