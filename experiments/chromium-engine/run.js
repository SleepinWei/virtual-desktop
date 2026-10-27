import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPaintLab } from '../chromium-paint/server.js';
import { capturePaint } from '../chromium-paint/capture.js';
import { verifyReplay } from '../chromium-paint/verify.js';
import { analyzeEngineEvidence } from './evidence.js';
import { sha256, verifyArtifacts } from './artifacts.js';

const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: {
  root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  output: { type: 'string', default: 'test-results/chromium-engine' },
} });
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'initializing',
  source, engineSplitGate: 'not-passed', serverRasterBypassed: false, modes: {},
  limitations: ['Picture-layer experiment only; Viz display/background, Canvas, WebGL and video are not disabled.'] };
const save = () => writeFile(join(output, 'engine-report.json'), JSON.stringify(report, null, 2));
await save();
try {
  if (!values.root) throw new Error('Pass --root or CHROMIUM_BUILD_ROOT pointing to the external build root');
  const statePath = join(resolve(values.root), 'chromium/virtual-desktop-build-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (!state.compiled || !state.ccTestsPassed || state.stage !== 'cc-tests-complete' || state.exitCode !== 0 ||
      state.revision !== source.revision || !state.binary || !state.binarySha256) {
    throw new Error('A successful pinned engine build and its C++ tests are required; no installed-Chrome fallback');
  }
  const patchSha256 = await sha256(new URL('./remote-paint.patch', import.meta.url));
  if (state.patchSha256 !== patchSha256) {
    throw new Error('Engine patch or executable checksum differs from the verified build state');
  }
  const artifacts = await verifyArtifacts(state, values.root);
  report.build = { statePath, revision: state.revision, binary: state.binary,
    binarySha256: state.binarySha256, artifacts, patchSha256, ccTestsPassed: true };
  report.status = 'running';
  await save();
  for (const [mode, remotePaint] of [['ordinary', false], ['remote-paint', true]]) {
    const directory = join(output, mode);
    await mkdir(directory, { recursive: true });
    for (const file of ['capture.json', 'replay.json', 'trace.json']) await rm(join(directory, file), { force: true });
    const lab = createPaintLab({ outputDir: directory });
    try {
      const baseUrl = await lab.listen();
      const capture = await capturePaint({ url: baseUrl + '/fixture.html', executablePath: state.binary,
        outputDir: directory, producerBufferBytes: 33554432, remotePaint });
      // The independent local replay/reference browser always uses ordinary
      // mode, even when the capture browser requested record-only layers.
      const replay = await verifyReplay({ baseUrl, outputDir: directory, executablePath: state.binary, manifest: capture });
      const trace = JSON.parse(await readFile(join(directory, 'trace.json'), 'utf8'));
      const engine = analyzeEngineEvidence(trace, { rendererPids: capture.provenance.rendererPids,
        traceComplete: capture.acceptance.traceComplete });
      report.modes[mode] = { directory, browser: capture.browser.product,
        traceComplete: capture.acceptance.traceComplete,
        nativePicturesCaptured: capture.acceptance.nativePicturesCaptured,
        clientReplayRendered: replay.clientReplayRendered, fixtureReplayPassed: replay.fixtureReplayPassed,
        stages: capture.stages.map(stage => ({ name: stage.name,
          records: stage.recordedPictures.length, pictures: stage.pictures.length })), engine };
      await save();
    } finally { await lab.close(); }
  }
  const ordinary = report.modes.ordinary, remote = report.modes['remote-paint'];
  report.status = ordinary.traceComplete && ordinary.fixtureReplayPassed && ordinary.engine.raster.eventCount > 0 &&
    remote.traceComplete && remote.fixtureReplayPassed && remote.engine.pictureLayerCandidate
    ? 'picture-layer-candidate' : 'acceptance-not-met';
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report, null, 2));
  // A limited candidate is intentionally not a successful full engine split.
  process.exitCode = report.status === 'picture-layer-candidate' ? 0 : 1;
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message };
  await save();
  console.error(error.message);
  process.exitCode = 1;
}
