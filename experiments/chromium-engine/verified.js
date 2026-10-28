import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sha256, verifyArtifacts } from './artifacts.js';

export async function verifiedEngine(root, { requireStream = false } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('CHROMIUM_BUILD_ROOT is required');
  root = resolve(root);
  const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url), 'utf8'));
  const state = JSON.parse(await readFile(join(root, 'chromium/virtual-desktop-build-state.json'), 'utf8'));
  const patchSha256 = await sha256(new URL('./remote-paint.patch', import.meta.url));
  if (!state.compiled || !state.ccTestsPassed || !state.vizTestsPassed || state.exitCode !== 0 ||
      state.stage !== 'engine-tests-complete' || state.revision !== source.revision || state.patchSha256 !== patchSha256 ||
      (requireStream && (source.stream?.version !== 1 || source.stream.transport !== 'authenticated-posix-unix-stream'))) {
    throw new Error('Require the current pinned native engine, stream producer and successful C++ tests');
  }
  const artifacts = await verifyArtifacts(state, root);
  const artifactsSha256 = createHash('sha256').update(JSON.stringify(Object.entries(artifacts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
  return { root, source, state, binary: state.binary, patchSha256, artifactsSha256 };
}
