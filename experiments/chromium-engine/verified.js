import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sha256, verifyArtifacts, artifactLayout } from './artifacts.js';

export async function verifiedEngine(root, { requireStream = false, layout = 'component' } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('CHROMIUM_BUILD_ROOT is required');
  root = resolve(root);
  const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url), 'utf8'));
  if (!['component', 'lean'].includes(layout)) throw new Error('Unknown build state selection');
  const stateName = layout === 'lean' ? 'virtual-desktop-lean-ninja-build-state.json' : 'virtual-desktop-build-state.json';
  const state = JSON.parse(await readFile(join(root, 'chromium', stateName), 'utf8'));
  const patchSha256 = await sha256(new URL('./remote-paint.patch', import.meta.url));
  const monolithic = state.engineLayout === 'monolithic';
  const requiredStage = layout === 'lean' ? 'lean-engine-tests-complete' : 'engine-tests-complete';
  if (!state.compiled || !state.ccTestsPassed || !state.vizTestsPassed || state.exitCode !== 0 ||
      state.stage !== requiredStage || (layout === 'lean' && !monolithic) || state.revision !== source.revision || state.patchSha256 !== patchSha256 ||
      (requireStream && (source.stream?.version !== 1 || source.stream.transport !== 'authenticated-posix-unix-stream'))) {
    throw new Error('Require the current pinned native engine, stream producer and successful C++ tests');
  }
  if (monolithic) {
    const evidence = state.cppTestsEvidence;
    if (!evidence || evidence.version !== 1 || evidence.revision !== source.revision || evidence.binarySha256 !== state.binarySha256 ||
      evidence.profileSha256 !== state.profileSha256 || !evidence.results?.cc?.passed || evidence.results.cc.count !== 17 ||
      !evidence.results?.viz?.passed || evidence.results.viz.count !== 4 ||
      !['cc_unittests', 'viz_unittests'].every(name => /^[a-f0-9]{64}$/.test(evidence.testArtifacts?.[name] ?? '')) ||
      !['cc', 'viz'].every(name => /^[a-f0-9]{64}$/.test(evidence.results[name].xmlSha256 ?? '')))
      throw new Error('Monolithic C++ evidence does not match the current executable/profile');
    if (layout === 'lean') {
      const directory = artifactLayout(state, root).directory;
      for (const name of ['cc_unittests', 'viz_unittests'])
        if (await sha256(join(directory, name)) !== evidence.testArtifacts[name]) throw new Error('C++ test executable differs: ' + name);
    }
  }
  const artifacts = await verifyArtifacts(state, root);
  const artifactsSha256 = createHash('sha256').update(JSON.stringify(Object.entries(artifacts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
  return { root, source, state, binary: artifactLayout(state, root).binary, patchSha256, artifactsSha256 };
}
