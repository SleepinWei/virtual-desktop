import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureLaunchArgs, capturePaint } from '../experiments/chromium-paint/capture.js';
import { analyzeEngineEvidence } from '../experiments/chromium-engine/evidence.js';
import { sha256, verifyArtifacts } from '../experiments/chromium-engine/artifacts.js';
import { browserProcessArgs, nativeWorkerEnvironment } from '../experiments/chromium-engine/browser-runtime.js';

const skp64 = Buffer.from('skiapict-synthetic-test-only').toString('base64');
const record = (frame, pid = 42, layer = 8) => ({ name: 'VirtualDesktop.RemotePaintRecord',
  cat: 'cc', pid, ts: frame * 10, args: { layer_id: layer, source_frame_number: frame, snapshot: { skp64 } } });
const noTiles = (frame, pid = 42, layer = 8) => ({ name: 'VirtualDesktop.RemotePaintNoTiles',
  cat: 'cc', pid, ts: frame * 10 + 1, args: { layer_id: layer, source_frame_number: frame } });
const options = { rendererPids: [42], traceComplete: true };

test('in-process GPU is an explicit macOS-only runtime option', () => {
  assert.deepEqual(browserProcessArgs({ mode: 'separate', platform: 'darwin' }), []);
  assert.deepEqual(browserProcessArgs({ mode: 'in-process', platform: 'darwin' }), ['--in-process-gpu']);
  assert.throws(() => browserProcessArgs({ mode: 'in-process', platform: 'linux' }), /Unsupported/);
  assert.throws(() => browserProcessArgs({ mode: '--arbitrary-flag', platform: 'darwin' }), /Unsupported/);
});

test('native workers only inherit the validated GPU option and the existing minimal environment', () => {
  const env = nativeWorkerEnvironment({ PATH: '/bin', NODE_ENV: 'development', VIRTUAL_DESKTOP_MAC_GPU_MODE: 'in-process',
    PRIVATE_TOKEN: 'must-not-pass', HOME: '/private-home' }, 'darwin');
  assert.deepEqual(env, { PATH: '/bin', NODE_ENV: 'production', VIRTUAL_DESKTOP_MAC_GPU_MODE: 'in-process' });
  assert.throws(() => nativeWorkerEnvironment({ VIRTUAL_DESKTOP_MAC_GPU_MODE: '--arbitrary-flag' }, 'darwin'), /Unsupported/);
});

test('engine and producer flags share one enable-features argument', () => {
  const args = captureLaunchArgs({ remotePaint: true, producerBufferBytes: 33554432 });
  assert.deepEqual(args, ['--enable-automation',
    '--enable-features=kPerfettoBackendParams:shared_memory_size_bytes/33554432,VirtualDesktopRemotePaint']);
  assert.deepEqual(captureLaunchArgs(), ['--enable-automation']);
  assert.throws(() => captureLaunchArgs({ remotePaint: '--arbitrary-flag' }), /boolean/);
  assert.deepEqual(captureLaunchArgs({ remotePaint: true, noDisplay: true }),
    ['--enable-automation', '--enable-features=VirtualDesktopRemotePaint,VirtualDesktopRemotePaintNoDisplay']);
  assert.throws(() => captureLaunchArgs({ noDisplay: true }), /requires remotePaint/);
});

test('a null display needs progressing native skip markers and no renderer draw entry', () => {
  const pictures = [record(1), noTiles(1), record(2), noTiles(2)];
  const skipped = ts => ({ name: 'VirtualDesktop.RemotePaintDisplaySkipped', cat: 'viz', pid: 99, ts,
    args: { surface_id: 'synthetic test surface', render_pass_count: 1 } });
  const scheduled = { name: 'Display::DrawAndSwap', ph: 'X', pid: 99, ts: 30 };
  const events = [...pictures, skipped(15), skipped(25), scheduled];
  assert.equal(analyzeEngineEvidence(events, options).recordOnlyDisplayCandidate, true);
  assert.equal(analyzeEngineEvidence(events, options).pixelDraw.eventCount, 0);
  for (const skips of [[], [skipped(15)], [skipped(15), skipped(15)], [skipped(1), skipped(2)],
    [skipped(15), { ...skipped(25), cat: 'blink.user_timing' }]]) {
    assert.equal(analyzeEngineEvidence([...pictures, ...skips], options).recordOnlyDisplayCandidate, false);
  }
  assert.equal(analyzeEngineEvidence([...events, { name: 'DirectRenderer::DrawFrame', ph: 'X', pid: 99, ts: 30 }],
    options).recordOnlyDisplayCandidate, false);
  assert.equal(analyzeEngineEvidence(events, { ...options, traceComplete: false }).recordOnlyDisplayCandidate, false);
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
  for (const name of ['headless_shell', 'libcc.dylib', 'libcc_base.dylib', 'libcc_paint.dylib', 'libblink_platform.dylib', 'libcomponents_viz_service.dylib']) {
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
