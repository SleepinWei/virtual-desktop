import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureLaunchArgs, capturePaint } from '../experiments/chromium-paint/capture.js';
import { analyzeEngineEvidence } from '../experiments/chromium-engine/evidence.js';
import { sha256, verifyArtifacts } from '../experiments/chromium-engine/artifacts.js';

const skp64 = Buffer.from('skiapict-synthetic-test-only').toString('base64');
const record = (frame, pid = 42, layer = 8) => ({ name: 'VirtualDesktop.RemotePaintRecord',
  cat: 'cc', pid, ts: frame * 10, args: { layer_id: layer, source_frame_number: frame, snapshot: { skp64 } } });
const noTiles = (frame, pid = 42, layer = 8) => ({ name: 'VirtualDesktop.RemotePaintNoTiles',
  cat: 'cc', pid, ts: frame * 10 + 1, args: { layer_id: layer, source_frame_number: frame } });
const options = { rendererPids: [42], traceComplete: true };

test('engine and producer flags share one enable-features argument', () => {
  const args = captureLaunchArgs({ remotePaint: true, producerBufferBytes: 33554432 });
  assert.deepEqual(args, ['--enable-automation',
    '--enable-features=kPerfettoBackendParams:shared_memory_size_bytes/33554432,VirtualDesktopRemotePaint']);
  assert.deepEqual(captureLaunchArgs(), ['--enable-automation']);
  assert.throws(() => captureLaunchArgs({ remotePaint: '--arbitrary-flag' }), /boolean/);
});

test('engine mode requires an explicit binary before launching anything', async () => {
  await assert.rejects(capturePaint({ url: 'http://127.0.0.1/fixture.html',
    outputDir: '/must-not-create', remotePaint: true }), /explicit patched executablePath/);
});

test('zero raster observations without positive engine evidence fail closed', () => {
  assert.equal(analyzeEngineEvidence([], options).status, 'missing-engine-evidence');
  assert.equal(analyzeEngineEvidence([record(1), noTiles(1)], options).status, 'insufficient-frame-progress');
  assert.equal(analyzeEngineEvidence([record(1), noTiles(1), record(2), noTiles(2)],
    { ...options, traceComplete: false }).status, 'incomplete-trace');
});

test('engine markers must match renderer, layer, source frame and temporal order', () => {
  for (const events of [
    [record(1), noTiles(1, 99), record(2), noTiles(2, 99)],
    [record(1), noTiles(1, 42, 9), record(2), noTiles(2, 42, 9)],
    [record(1), noTiles(7), record(2), noTiles(8)],
    [record(1), { ...noTiles(1), ts: 1 }, record(2), { ...noTiles(2), ts: 1 }],
  ]) assert.equal(analyzeEngineEvidence(events, options).status, 'missing-engine-evidence');
});

test('observed raster fails an otherwise positive picture-layer candidate', () => {
  const evidence = analyzeEngineEvidence([record(1), noTiles(1), record(2), noTiles(2),
    { name: 'RasterTask', pid: 99, ph: 'X', ts: 25 }], options);
  assert.equal(evidence.status, 'raster-observed');
  assert.equal(evidence.pictureLayerCandidate, false);
});

test('frame numbers from different renderers cannot manufacture progress', () => {
  assert.equal(analyzeEngineEvidence([record(1), noTiles(1), record(2, 43), noTiles(2, 43)],
    { ...options, rendererPids: [42, 43] }).status, 'insufficient-frame-progress');
  assert.equal(analyzeEngineEvidence([{ ...record(1), cat: 'blink.user_timing' }, noTiles(1)], options).status,
    'missing-engine-evidence');
});

test('paired native records with progressing frames remain a limited candidate', () => {
  const evidence = analyzeEngineEvidence([record(1), noTiles(1), record(2), noTiles(2),
    { name: 'Display::DrawAndSwap', ph: 'X', pid: 99 }], options);
  assert.equal(evidence.status, 'picture-layer-candidate');
  assert.deepEqual(evidence.positiveEvidence.frameNumbers, [1, 2]);
  assert.equal(evidence.draw.eventCount, 1);
  assert.equal(evidence.serverRasterBypassed, false);
  assert.equal(evidence.engineSplitGate, 'not-passed');
});

test('a matching shell executable cannot hide an altered engine component', async t => {
  const root = await mkdtemp(join(tmpdir(), 'engine-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'chromium/src/out/VirtualDesktop');
  await mkdir(output, { recursive: true });
  const artifacts = {};
  for (const name of ['headless_shell', 'libcc.dylib', 'libcc_base.dylib', 'libcc_paint.dylib', 'libblink_platform.dylib']) {
    await writeFile(join(output, name), `test fixture only: ${name}`);
    artifacts[name] = await sha256(join(output, name));
  }
  const state = { binary: join(output, 'headless_shell'), artifacts, binarySha256: artifacts.headless_shell };
  assert.equal(await verifyArtifacts(state, root), artifacts);
  await writeFile(join(output, 'libcc.dylib'), 'changed engine library');
  await assert.rejects(verifyArtifacts(state, root), /checksum differs: libcc.dylib/);
  await assert.rejects(verifyArtifacts({ ...state, artifacts: { headless_shell: artifacts.headless_shell } }, root),
    /Missing component fingerprint/);
  await assert.rejects(verifyArtifacts({ ...state, binary: '/unrelated/headless_shell' }, root), /outside/);
});
