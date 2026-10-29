import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPaintLab } from '../chromium-paint/server.js';
import { capturePaint } from '../chromium-paint/capture.js';
import { verifyReplay } from '../chromium-paint/verify.js';
import { analyzeEngineEvidence } from './evidence.js';
import { verifiedEngine } from './verified.js';
import { loadReplayRuntime, verifyRuntimeBuild } from '../chromium-paint/runtime.js';

const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: {
  root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  output: { type: 'string', default: 'test-results/chromium-engine' },
  canvaskit: { type: 'string' },
} });
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'initializing',
  source, engineSplitGate: 'not-passed', serverRasterBypassed: false, modes: {},
  limitations: ['Trusted fixture only; Canvas, WebGL, video, image decoding and general layer/property-tree transport are not covered.'] };
const save = () => writeFile(join(output, 'engine-report.json'), JSON.stringify(report, null, 2));
await save();
try {
  if (!values.root) throw new Error('Pass --root or CHROMIUM_BUILD_ROOT pointing to the external build root');
  const statePath = join(resolve(values.root), 'chromium/virtual-desktop-build-state.json');
  const engineBuild = await verifiedEngine(values.root, { requireStream: true });
  const state = { ...engineBuild.state, binary: engineBuild.binary };
  const { patchSha256 } = engineBuild, artifacts = state.artifacts;
  const runtime = await loadReplayRuntime(values.canvaskit);
  if (values.canvaskit && runtime.metadata.skiaRevision !== source.skiaRevision) {
    throw new Error('Custom CanvasKit must match the pinned Chromium Skia revision');
  }
  if (values.canvaskit) await verifyRuntimeBuild(runtime, values.canvaskit, values.root, source);
  report.replayRuntime = runtime.metadata;
  report.build = { statePath, revision: state.revision, binary: state.binary,
    binarySha256: state.binarySha256, artifacts, patchSha256, ccTestsPassed: true, vizTestsPassed: true };
  report.status = 'running';
  await save();
  for (const [mode, remotePaint, noDisplay] of [['ordinary', false, false], ['remote-paint', true, false], ['record-only-display', true, true]]) {
    const directory = join(output, mode);
    await mkdir(directory, { recursive: true });
    for (const file of ['capture.json', 'replay.json', 'trace.json']) await rm(join(directory, file), { force: true });
    const lab = createPaintLab({ outputDir: directory, canvasKitDirectory: values.canvaskit });
    try {
      const baseUrl = await lab.listen();
      const capture = await capturePaint({ url: baseUrl + '/fixture.html', executablePath: state.binary,
        outputDir: directory, producerBufferBytes: 33554432, remotePaint, noDisplay, lifecycle: true });
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
        lifecycle: capture.lifecycle,
        stages: capture.stages.map(stage => ({ name: stage.name,
          records: stage.recordedPictures.length, pictures: stage.pictures.length,
          pictureHashes: stage.pictures.map(picture => picture.sha256).sort() })), engine };
      await save();
    } finally { await lab.close(); }
  }
  const ordinary = report.modes.ordinary, remote = report.modes['remote-paint'], display = report.modes['record-only-display'];
  report.recordingsMatch = [remote, display].every(mode =>
    JSON.stringify(mode.stages.map(stage => stage.pictureHashes)) ===
    JSON.stringify(ordinary.stages.map(stage => stage.pictureHashes)));
  const picturePass = ordinary.traceComplete && ordinary.fixtureReplayPassed && ordinary.engine.raster.eventCount > 0 &&
    ordinary.lifecycle?.passed && remote.lifecycle?.passed &&
    ordinary.engine.pixelDraw.eventCount > 0 && remote.fixtureReplayPassed && remote.engine.pictureLayerCandidate;
  report.status = picturePass && report.recordingsMatch && display.lifecycle?.passed && display.fixtureReplayPassed && display.engine.recordOnlyDisplayCandidate
    ? 'record-only-display-candidate' : picturePass ? 'picture-layer-candidate' : 'acceptance-not-met';
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report, null, 2));
  // A limited candidate is intentionally not a successful full engine split.
  process.exitCode = report.status === 'record-only-display-candidate' ? 0 : 1;
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message };
  await save();
  console.error(error.message);
  process.exitCode = 1;
}
