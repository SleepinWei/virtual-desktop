import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createFrameLab } from '../chromium-paint/frame-server.js';
import { captureFrames, frameFixtureFingerprint } from '../chromium-paint/frame-capture.js';
import { verifyFrames } from '../chromium-paint/frame-verify.js';
import { layerIds } from '../chromium-paint/frame-protocol.js';
import { loadReplayRuntime, verifyRuntimeBuild } from '../chromium-paint/runtime.js';
import { sha256, verifyArtifacts } from './artifacts.js';
import { analyzeEngineEvidence } from './evidence.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string' }, output: { type: 'string', default: 'test-results/chromium-frames' }, saved: { type: 'boolean', default: false } } });
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', engineSplitGate: 'not-passed', serverRasterBypassed: false };
const save = () => writeFile(join(output, 'frame-engine-report.json'), JSON.stringify(report, null, 2));
await save();
let lab;
try {
  if (!values.root || !values.canvaskit) throw new Error('Pass --root and --canvaskit for the verified native engine and matching replay build');
  const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url), 'utf8'));
  const state = JSON.parse(await readFile(join(resolve(values.root), 'chromium/virtual-desktop-build-state.json'), 'utf8'));
  const patchSha256 = await sha256(new URL('./remote-paint.patch', import.meta.url));
  if (!state.compiled || !state.ccTestsPassed || !state.vizTestsPassed || state.stage !== 'engine-tests-complete' ||
      state.exitCode !== 0 || state.revision !== source.revision || state.patchSha256 !== patchSha256) throw new Error('Require the current pinned build and successful native tests');
  const artifacts = await verifyArtifacts(state, values.root), runtime = await loadReplayRuntime(values.canvaskit);
  const artifactsSha256 = createHash('sha256').update(JSON.stringify(Object.entries(artifacts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
  await verifyRuntimeBuild(runtime, values.canvaskit, values.root, source);
  report.build = { revision: state.revision, skiaRevision: source.skiaRevision, binary: state.binary,
    binarySha256: state.binarySha256, artifacts, artifactsSha256, patchSha256 };
  report.runtime = runtime.metadata;
  lab = createFrameLab({ outputDir: output, canvasKitDirectory: values.canvaskit });
  const baseUrl = await lab.listen();
  const manifest = values.saved ? JSON.parse(await readFile(join(output, 'frame-capture.json'), 'utf8'))
    : await captureFrames({ url: baseUrl + '/frames.html', executablePath: state.binary, outputDir: output });
  if (values.saved && (manifest.buildPatchSha256 !== patchSha256 || manifest.buildBinarySha256 !== state.binarySha256 ||
      manifest.buildArtifactsSha256 !== artifactsSha256 ||
      JSON.stringify(manifest.fixtureSha256) !== JSON.stringify(await frameFixtureFingerprint()))) throw new Error('Saved native frames do not match the verified build or current fixture');
  manifest.buildPatchSha256 = patchSha256;
  manifest.buildBinarySha256 = state.binarySha256;
  manifest.buildArtifactsSha256 = artifactsSha256;
  await writeFile(join(output, 'frame-capture.json'), JSON.stringify(manifest, null, 2));
  const trace = JSON.parse(await readFile(join(output, 'frame-trace.json'), 'utf8'));
  report.engine = analyzeEngineEvidence(trace, { rendererPids: manifest.provenance.rendererPids, traceComplete: manifest.trace.complete });
  report.replay = await verifyFrames({ baseUrl, outputDir: output, executablePath: state.binary, manifest });
  report.stages = manifest.stages.map(stage => ({ name: stage.name, frameId: stage.frame.id, native: stage.frame.native,
    layerIds: [...layerIds(stage.frame)], surfaces: stage.frame.surfaces.length,
    resources: stage.frame.resources.length, resourceBytes: stage.frame.resources.reduce((sum, item) => sum + item.bytes, 0),
    scrollOffsets: stage.frame.scrollOffsets, evidence: stage.evidence }));
  const before = manifest.stages[0].frame, changed = manifest.stages[1].frame,
    scrolled = manifest.stages[2].frame, removed = manifest.stages[3].frame;
  const entries = frame => frame.surfaces.flatMap(surface => surface.items);
  const earlier = new Map(entries(before).map(item => [`${item.kind}:${item.id}`, item]));
  const pairs = entries(changed).flatMap(item => earlier.has(`${item.kind}:${item.id}`) ? [[earlier.get(`${item.kind}:${item.id}`), item]] : []);
  report.nativeChanges = {
    multiLayer: layerIds(before).size >= 3 && before.surfaces.length >= 2,
    transform: pairs.some(([a, b]) => JSON.stringify(a.transform) !== JSON.stringify(b.transform)),
    rotation: entries(changed).some(item => item.transform[1] !== 0 && item.transform[4] !== 0),
    clip: pairs.some(([a, b]) => JSON.stringify(a.clip) !== JSON.stringify(b.clip)),
    groupOpacity: pairs.some(([a, b]) => a.kind === 'surface' && a.opacity !== b.opacity),
    order: before.surfaces.some(surface => JSON.stringify(surface.items.map(item => `${item.kind}:${item.id}`)) !==
      JSON.stringify(changed.surfaces.find(item => item.id === surface.id)?.items.map(item => `${item.kind}:${item.id}`))),
    scroll: JSON.stringify(changed.scrollOffsets) !== JSON.stringify(scrolled.scrollOffsets),
    removedLayerIds: [...layerIds(scrolled)].filter(id => !layerIds(removed).has(id)),
  };
  report.transport = lab.stats;
  report.status = report.replay.passed && report.engine.recordOnlyDisplayCandidate && report.nativeChanges.multiLayer &&
    ['transform', 'rotation', 'clip', 'groupOpacity', 'order', 'scroll'].every(key => report.nativeChanges[key]) && report.nativeChanges.removedLayerIds.length
    ? 'native-frame-candidate' : 'acceptance-not-met';
  report.limitations = ['Trusted fixed 2D fixture and trace transport only; not a production Chromium backend.',
    'Images, filters, masking, non-SrcOver blending, 3D, iframe surfaces, Canvas, WebGL, video and copy-output are rejected or unverified.',
    'SKP resources include embedded fonts; independent font/image deltas, DPR/zoom, resumption, cost and multi-worker handoff remain unverified.'];
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, stages: report.stages, nativeChanges: report.nativeChanges,
    raster: report.engine.raster.eventCount, pixelDraw: report.engine.pixelDraw.eventCount,
    replayPassed: report.replay.passed, errors: report.replay.errors, report: join(output, 'frame-engine-report.json') }, null, 2));
  process.exitCode = report.status === 'native-frame-candidate' ? 0 : 1;
} catch (error) {
  report.status = 'failed'; report.failure = error.message; await save(); console.error(error.stack); process.exitCode = 1;
} finally { await lab?.close(); }
