import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../experiments/chromium-engine/artifacts.js';
import { loadReplayRuntime, verifyRuntimeBuild } from '../experiments/chromium-paint/runtime.js';

test('custom replay runtime fingerprints prevent an older or altered WASM from looking verified', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'canvaskit-runtime-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const metadata = { schemaVersion: 1, id: 'synthetic test only', backend: 'software',
    skiaRevision: 'a'.repeat(40), assets: {} };
  for (const name of ['canvaskit.js', 'canvaskit.wasm']) {
    await writeFile(join(directory, name), 'synthetic fixture only: ' + name);
    metadata.assets[name] = await sha256(join(directory, name));
  }
  await writeFile(join(directory, 'runtime.json'), JSON.stringify(metadata));
  const loaded = await loadReplayRuntime(directory);
  assert.deepEqual(loaded.metadata, metadata);
  await writeFile(join(directory, 'canvaskit.wasm'), 'different or stale WASM');
  assert.equal(loaded.assets.get('canvaskit.wasm').toString(), 'synthetic fixture only: canvaskit.wasm');
  await assert.rejects(loadReplayRuntime(directory), /checksum differs: canvaskit.wasm/);
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ ...metadata, skiaRevision: 'unpinned' }));
  await assert.rejects(loadReplayRuntime(directory), /metadata/);
});

test('runtime acceptance rejects stale build success and changed compiler configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvaskit-build-state-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, 'canvaskit/out');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'args.gn'), 'synthetic GN arguments');
  const metadata = { skiaRevision: 'a'.repeat(40), assets: { 'canvaskit.js': 'b'.repeat(64), 'canvaskit.wasm': 'c'.repeat(64) },
    gnArgsSha256: await sha256(join(directory, 'args.gn')),
    patchSha256: await sha256(new URL('../experiments/chromium-engine/canvaskit-cff.patch', import.meta.url)) };
  const state = { compiled: true, stage: 'build-complete', exitCode: 0, output: directory,
    skiaRevision: metadata.skiaRevision, assets: metadata.assets };
  const statePath = join(root, 'canvaskit/build-state.json');
  await writeFile(statePath, JSON.stringify(state));
  await verifyRuntimeBuild({ metadata }, directory, root, metadata);
  await writeFile(statePath, JSON.stringify({ ...state, compiled: false }));
  await assert.rejects(verifyRuntimeBuild({ metadata }, directory, root, metadata), /successful matching/);
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(statePath, JSON.stringify({ ...state, distributionFormat: 'native-runtime-v1', output: 'canvaskit/out' }));
  await verifyRuntimeBuild({ metadata }, directory, root, metadata);
  await writeFile(statePath, JSON.stringify({ ...state, distributionFormat: 'native-runtime-v1', output: '../canvaskit/out' }));
  await assert.rejects(verifyRuntimeBuild({ metadata }, directory, root, metadata), /successful matching/);
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(directory, 'args.gn'), 'changed GN arguments');
  await assert.rejects(verifyRuntimeBuild({ metadata }, directory, root, metadata), /configuration or patch/);
});
