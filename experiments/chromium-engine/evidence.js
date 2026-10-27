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
    key(marker) === key(event) && Number.isFinite(event.ts) && marker.ts >= event.ts));
  const frameNumbers = [...new Set(paired.map(event => event.args.source_frame_number))].sort((a, b) => a - b);
  const framesByRenderer = Object.fromEntries([...expected].map(pid => [pid,
    [...new Set(paired.filter(event => event.pid === pid).map(event => event.args.source_frame_number))].sort((a, b) => a - b)]));
  const progressing = Object.values(framesByRenderer).some(frames => frames.length >= 2);
  const observed = analyzeTrace(events);
  const pictureLayerCandidate = traceComplete && paired.length > 0 && progressing && observed.raster.eventCount === 0;
  return {
    status: !traceComplete ? 'incomplete-trace'
      : !paired.length ? 'missing-engine-evidence'
        : !progressing ? 'insufficient-frame-progress'
          : observed.raster.eventCount ? 'raster-observed' : 'picture-layer-candidate',
    engineSplitGate: 'not-passed', serverRasterBypassed: false,
    pictureLayerCandidate,
    positiveEvidence: { recordCount: records.length, pairedRecordCount: paired.length,
      noTileMarkerCount: noTiles.length, frameNumbers, framesByRenderer, rendererPids: [...expected] },
    raster: observed.raster, draw: observed.draw,
    limitations: [
      'No trace events is not proof that a pixel path did not run.',
      'This patch covers picture-layer tiles and picture quads; Viz display/background, Canvas, WebGL and video are outside its scope.',
      'Consecutive source frame numbers show new recordings, not a complete acknowledgement or frame/property-tree protocol.',
      'Client replay, visual equality, CPU/RSS/thread measurements and ordinary-mode controls are separate acceptance conditions.',
    ],
  };
}
