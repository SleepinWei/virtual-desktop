import { analyzeTrace, extractPictures } from '../chromium-paint/capture.js';

/** Positive engine markers accompany, but cannot replace, complete runtime proof. */
export function analyzeEngineEvidence(trace, { rendererPids = [], traceComplete = false } = {}) {
  const events = Array.isArray(trace) ? trace : trace?.traceEvents;
  if (!Array.isArray(events)) throw new TypeError('Expected traceEvents');
  const expected = new Set(rendererPids);
  const key = event => `${event.pid}:${event.args?.layer_id}:${event.args?.source_frame_number}`;
  const valid = event => expected.has(event.pid) &&
    event.cat?.split(',').includes('cc') &&
    Number.isInteger(event.args?.layer_id) && event.args.layer_id > 0 &&
    Number.isInteger(event.args?.source_frame_number) && event.args.source_frame_number >= 0;
  const records = events.filter(event => event.name === 'VirtualDesktop.RemotePaintRecord' && valid(event));
  const noTiles = events.filter(event => event.name === 'VirtualDesktop.RemotePaintNoTiles' && valid(event));
  const exported = new Set(extractPictures(records).map(picture => picture.eventIndex));
  const paired = records.filter((event, index) => exported.has(index) && noTiles.some(marker =>
    key(marker) === key(event) && Number.isFinite(event.ts) && Number.isFinite(marker.ts) && marker.ts >= event.ts));
  const frameNumbers = [...new Set(paired.map(event => event.args.source_frame_number))].sort((a, b) => a - b);
  const framesByRenderer = Object.fromEntries([...expected].map(pid => [pid,
    [...new Set(paired.filter(event => event.pid === pid).map(event => event.args.source_frame_number))].sort((a, b) => a - b)]));
  const progressing = Object.values(framesByRenderer).some(frames => frames.length >= 2);
  const observed = analyzeTrace(events);
  const pictureLayerCandidate = traceComplete && paired.length > 0 && progressing && observed.raster.eventCount === 0;
  const skippedDisplay = events.filter(event => event.name === 'VirtualDesktop.RemotePaintDisplaySkipped' &&
    event.cat?.split(',').includes('viz') && Number.isInteger(event.pid) && Number.isFinite(event.ts) &&
    typeof event.args?.surface_id === 'string' && event.args.surface_id.length > 0 &&
    Number.isInteger(event.args?.render_pass_count) && event.args.render_pass_count > 0);
  const firstRecordTime = Math.min(...paired.map(event => event.ts));
  const displayProgress = [...new Set(skippedDisplay.map(event => event.pid))].some(pid =>
    new Set(skippedDisplay.filter(event => event.pid === pid && event.ts >= firstRecordTime).map(event => event.ts)).size >= 2);
  const recordOnlyDisplayCandidate = pictureLayerCandidate && displayProgress && observed.pixelDraw.eventCount === 0;
  return {
    status: !traceComplete ? 'incomplete-trace'
      : !paired.length ? 'missing-engine-evidence'
        : !progressing ? 'insufficient-frame-progress'
          : observed.raster.eventCount ? 'raster-observed' : 'picture-layer-candidate',
    engineSplitGate: 'not-passed', serverRasterBypassed: false,
    pictureLayerCandidate,
    recordOnlyDisplayCandidate,
    positiveEvidence: { recordCount: records.length, pairedRecordCount: paired.length,
      noTileMarkerCount: noTiles.length, frameNumbers, framesByRenderer, rendererPids: [...expected] },
    displayEvidence: { skippedFrameCount: skippedDisplay.length,
      pids: [...new Set(skippedDisplay.map(event => event.pid))],
      surfaceIds: [...new Set(skippedDisplay.map(event => event.args.surface_id))] },
    raster: observed.raster, draw: observed.draw, pixelDraw: observed.pixelDraw,
    limitations: [
      'No trace events is not proof that a pixel path did not run.',
      'The optional headless NullRenderer bypasses Viz pixel drawing; Canvas, WebGL, video and image decoding are outside its scope.',
      'Consecutive source frame numbers show new recordings, not a complete acknowledgement or frame/property-tree protocol.',
      'Client replay, visual equality, CPU/RSS/thread measurements and ordinary-mode controls are separate acceptance conditions.',
    ],
  };
}
