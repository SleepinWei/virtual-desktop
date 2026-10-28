// Synthetic protocol test records, never used as native engine evidence.
import { createHash } from 'node:crypto';
import { normalizeNativeFrame } from '../experiments/chromium-paint/native-frame.js';
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function resource(label) {
  const data = Buffer.from('skiapict-unit-test-' + label), id = createHash('sha256').update(data).digest('hex');
  return { descriptor: { id, path: `pictures/${id}.skp`, bytes: data.length }, data };
}
export function scene(time = 1, label = 'a', layer = 8) {
  const { descriptor } = resource(label);
  return { version: 1, id: `42:9:${time}`, native: { pid: 42, treeId: 9, ts: time, sourceFrameNumber: time },
    viewport: { width: 960, height: 720 }, background: [1, 1, 1, 1], root: 1, scrollOffsets: [],
    resources: [descriptor], surfaces: [{ id: 1, rect: [0, 0, 960, 720], items: [{ kind: 'picture', id: layer,
      transform: [...identity], clipped: true, clip: [0, 0, 960, 720], opacity: 1, bounds: [0, 0, 960, 720], resource: descriptor.id }] }] };
}
export function nativeEvent(time = 1) {
  const picture = (id, target) => ({ kind: 'picture', id, target, bounds: [0, 0, 100, 100], transform: [...identity],
    opacity: 1, is_clipped: true, clip: [0, 0, 100, 100], record: { skp64: resource('a').data.toString('base64') } });
  return { name: 'VirtualDesktop.RemotePaintFrame', cat: 'cc', ph: 'X', pid: 42, tid: 43, ts: time,
    args: { snapshot: { version: 1, tree_id: 9, source_frame_number: 5, viewport: [0, 0, 960, 720], background: [1, 1, 1, 1],
      root: 1, surfaces: [{ id: 1, content_rect: [0, 0, 960, 720] }, { id: 2, content_rect: [0, 0, 100, 100] }],
      entries: [picture(3, 2), { kind: 'solid', id: 4, target: 2, bounds: [0, 0, 100, 100], color: [1, 0, 0, 1],
        transform: [...identity], opacity: 1, is_clipped: false, clip: [0, 0, 0, 0] },
      { kind: 'surface', id: 2, target: 1, transform: [...identity], opacity: .5, is_clipped: true, clip: [20, 30, 100, 100] }, picture(5, 1)],
      scroll_offsets: [{ id: 'native-scroll', offset: [0, 180] }], unsupported: [], supported: true,
      surface_count: 2, entry_count: 4, scroll_count: 1, unsupported_count: 0 } } };
}
export function groupedScene() { return normalizeNativeFrame(nativeEvent()).frame; }
export const packet = (seq, frame = scene(seq), epoch = 'test-epoch') => ({ version: 1, kind: 'frame', epoch, seq,
  frame, resources: frame.resources.map(item => item.id) });
export const ack = item => ({ version: 1, kind: 'presented', epoch: item.epoch, seq: item.seq,
  frameId: item.frame.id, resources: item.frame.resources.map(resource => resource.id) });
