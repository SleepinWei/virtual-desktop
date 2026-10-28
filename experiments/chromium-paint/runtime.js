import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { sha256 } from '../chromium-engine/artifacts.js';

const assetNames = ['canvaskit.js', 'canvaskit.wasm'];
const bundled = new URL('../../node_modules/canvaskit-wasm/bin/full/', import.meta.url);

// Fingerprint the actual bytes served to the client, including custom builds.
export async function loadReplayRuntime(directory) {
  const root = directory ? resolve(directory) : bundled;
  // Retain the verified bytes so a later rebuild cannot change the WASM served
  // under an earlier fingerprint while this lab is running.
  const assets = new Map(await Promise.all(assetNames.map(async name => [name,
    await readFile(root instanceof URL ? new URL(name, root) : join(root, name))])));
  const hashes = Object.fromEntries([...assets].map(([name, data]) =>
    [name, createHash('sha256').update(data).digest('hex')]));
  if (!directory) {
    return { assets, metadata: { schemaVersion: 1,
      id: 'canvaskit-wasm@0.42.0/full', backend: 'software', assets: hashes } };
  }
  const metadata = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  if (metadata.schemaVersion !== 1 || typeof metadata.id !== 'string' || !metadata.id ||
      metadata.backend !== 'software' || !/^[a-f0-9]{40}$/.test(metadata.skiaRevision || '')) {
    throw new Error('Invalid custom CanvasKit runtime metadata');
  }
  for (const name of assetNames) {
    const expected = metadata.assets?.[name];
    if (!/^[a-f0-9]{64}$/.test(expected || '') || hashes[name] !== expected) {
      throw new Error('CanvasKit runtime checksum differs: ' + name);
    }
  }
  return { assets, metadata };
}

export async function verifyRuntimeBuild(runtime, directory, root, source) {
  const state = JSON.parse(await readFile(join(resolve(root), 'canvaskit/build-state.json'), 'utf8'));
  if (!state.compiled || state.stage !== 'build-complete' || state.exitCode !== 0 ||
      state.output !== resolve(directory) || state.skiaRevision !== source.skiaRevision ||
      assetNames.some(name => state.assets?.[name] !== runtime.metadata.assets[name])) {
    throw new Error('A successful matching CanvasKit build state is required');
  }
  const patch = new URL('../chromium-engine/canvaskit-cff.patch', import.meta.url);
  if (runtime.metadata.gnArgsSha256 !== await sha256(join(resolve(directory), 'args.gn')) ||
      runtime.metadata.patchSha256 !== await sha256(patch)) {
    throw new Error('CanvasKit configuration or patch differs from the verified runtime');
  }
}
