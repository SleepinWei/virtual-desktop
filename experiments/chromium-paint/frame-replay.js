import { FrameReceiver, layerIds } from './frame-protocol.js';
import { createFramePainter } from './frame-renderer.js';
import { createNativeDecoder } from './font-runtime.js';

const $ = selector => document.querySelector(selector);
let receiver, painter, metadata, runtime, epoch, decoder;
const packets = [];
const downloads = { resources: 0, bytes: 0 };
function report(status, value) {
  document.documentElement.dataset.status = status;
  $('#state').textContent = status === 'ready' ? 'Native frame ready' : status;
  $('#result').textContent = JSON.stringify(value, null, 2);
}
async function request(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function consume(packet) {
  const result = await receiver.receive(packet);
  if (result.status !== 'presented') return result;
  packets.push(structuredClone(packet));
  if (packets.length > 2) packets.shift();
  const acknowledged = await request('/api/ack', result.ack);
  if (acknowledged.packet) return consume(acknowledged.packet);
  // Another asynchronous frame may have completed while this ACK was in flight.
  if (receiver.state.seq !== packet.seq) return result;
  const stage = metadata.stages.find(stage => stage.frameId === packet.frame.id)?.name;
  $('#skp').dataset.stage = stage; $('#skp').dataset.seq = String(packet.seq);
  report('ready', { stage, frameId: packet.frame.id, native: packet.frame.native,
    layers: layerIds(packet.frame).size, surfaces: packet.frame.surfaces.length,
    scrollOffsets: packet.frame.scrollOffsets, removedLayerIds: result.removedLayerIds,
    receiver: receiver.state, channel: acknowledged.channel, downloads, runtime,
    scope: 'Authoritative full frame with native grouping; bounded 2D picture/solid subset.',
    engineSplitGate: 'not-passed', serverRasterBypassed: false });
  return result;
}
async function loadStage(name) {
  report('loading', { stage: name });
  try {
    const offered = await request(`/api/frame?epoch=${encodeURIComponent(epoch)}&stage=${encodeURIComponent(name)}`);
    return offered.packet ? await consume(offered.packet) : { status: 'queued' };
  } catch (error) { report('unsupported', { error: error.message, fallback: 'none' }); throw error; }
}

try {
  metadata = await request('/api/capture'); runtime = await request('/runtime.json');
  ({ epoch } = await request('/api/session', {}));
  const kit = await window.CanvasKitInit({ locateFile: name => '/' + name });
  painter = createFramePainter(kit, $('#skp'));
  decoder = createNativeDecoder(kit, { fetchResource: resource => fetch('/' + resource.path), downloads });
  receiver = new FrameReceiver(epoch, {
    load: decoder.load,
    present: (frame, pictures) => painter.present(frame, pictures),
    release: decoder.release,
  });
  window.frameLab = { loadStage, consume, packets,
    state: () => ({ receiver: receiver.state, downloads: { ...downloads } }) };
  $('#stage').replaceChildren(...metadata.stages.map(stage => {
    const option = document.createElement('option'); option.value = stage.name; option.textContent = stage.name; return option;
  }));
  $('#stage').addEventListener('change', () => { loadStage($('#stage').value).catch(() => {}); });
  await loadStage(metadata.stages[0].name);
} catch (error) { report('unsupported', { error: error.message, fallback: 'none' }); }
window.addEventListener('pagehide', () => { receiver?.reset(epoch); decoder?.dispose(); painter?.dispose(); });
