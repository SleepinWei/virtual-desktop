import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeHeadlessTrace, extractHeadlessPictures, runHeadlessProbe, trustedHeadlessProbeUrl } from '../experiments/chromium-paint/headless-probe.js';

const skp64 = Buffer.from('skiapict-test-record').toString('base64');
const interval = content => [
  { name: 'headless-probe:no-display:start', ts: 10, pid: 42, ph: 'R' },
  ...content,
  { name: 'headless-probe:no-display:end', ts: 30, pid: 42, ph: 'R' },
];

test('a missing paint record or incomplete trace cannot prove a raster bypass', () => {
  assert.equal(analyzeHeadlessTrace(interval([])).status, 'no-paint-record');
  assert.equal(analyzeHeadlessTrace([]).status, 'insufficient-trace');
  assert.equal(analyzeHeadlessTrace(interval([]), { traceComplete: false }).status, 'insufficient-trace');
  assert.equal(analyzeHeadlessTrace([], { apiSupported: false }).status, 'unsupported');
});

test('raster tasks fail the bounded candidate even when its paint data exists', () => {
  const result = analyzeHeadlessTrace(interval([
    { name: 'cc::DisplayItemList:snapshot', ts: 15, args: { snapshot: { skp64 } } },
    { name: 'RasterTask', ts: 20, pid: 42, tid: 2, ph: 'X', dur: 5 },
    { name: 'RasterizerTaskImpl::RunOnWorkerThread', ts: 21, pid: 42, tid: 2, ph: 'B' },
  ]));
  assert.equal(result.status, 'raster-observed');
  assert.equal(result.raster.measured, 2);
  assert.equal(result.pictures.measured, 1);
  assert.equal(result.gatePassed, false);
});

test('inspection after the no-display interval cannot hide a missing paint export', () => {
  const result = analyzeHeadlessTrace([
    ...interval([]), { name: 'cc::DisplayItemList:snapshot', ts: 40, args: { skp64 } },
    { name: 'RasterTask', ts: 45, pid: 42, ph: 'X' },
  ]);
  assert.equal(result.status, 'no-paint-record');
  assert.equal(result.pictures.measured, 0);
  assert.equal(result.pictures.entireTrace, 1);
  assert.equal(result.raster.measured, 0);
  assert.equal(result.raster.entireTrace, 1);
});

test('a zero-raster trace with SKP remains an unverified candidate', () => {
  const result = analyzeHeadlessTrace(interval([{ name: 'snapshot', ts: 20, args: { skp64 } }]));
  assert.equal(result.status, 'candidate-unverified');
  assert.equal(result.gatePassed, false);
  assert.equal(result.measurement.rendererPid, 42);
});

test('SKP extraction deduplicates binary records and rejects other base64 payloads', () => {
  const pictures = extractHeadlessPictures([{ args: { snapshots: [{ skp64 }, { skp64 }, { skp64: Buffer.from('not-a-picture').toString('base64') }] } }]);
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].bytes.toString(), 'skiapict-test-record');
});

test('headless probe accepts only credential-free HTTP(S) loopback URLs', () => {
  for (const url of ['http://127.0.0.1:8080/fixture.html', 'https://localhost/fixture.html', 'http://[::1]:8080/fixture.html']) {
    assert.equal(trustedHeadlessProbeUrl(url), url);
  }
  for (const url of ['https://example.com/fixture.html', 'file:///tmp/fixture.html', 'http://user:secret@localhost/fixture.html', 'http://localhost.example.com/fixture.html']) {
    assert.throws(() => trustedHeadlessProbeUrl(url), /trusted HTTP\(S\) loopback/);
  }
});

test('a missing explicit headless binary persists an unsupported report without launching or falling back', async t => {
  const outputDir = await mkdtemp(join(tmpdir(), 'headless-no-binary-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const result = await runHeadlessProbe({ url: 'http://127.0.0.1/fixture.html', outputDir, executablePath: '' });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.needsBinary, true);
  assert.equal(result.failure.code, 'HEADLESS_BINARY_REQUIRED');
  assert.equal(result.fallback, 'none');
  assert.equal(result.browser, null);
  assert.equal(result.commands.length, 0);
  assert.equal(result.gatePassed, false);
  assert.equal(JSON.parse(await readFile(join(outputDir, 'headless-report.json'), 'utf8')).needsBinary, true);
});
