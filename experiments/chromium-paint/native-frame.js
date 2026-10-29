import { createHash } from 'node:crypto';
import { FRAME_LIMITS, FRAME_VERSION, validateFrame } from './frame-protocol.js';

export function normalizeNativeFrame(event) {
  if (event?.name !== 'VirtualDesktop.RemotePaintFrame' || !event.cat?.split(',').includes('cc') ||
      !Number.isInteger(event.pid) || !Number.isFinite(event.ts)) throw new Error('Missing native cc frame provenance');
  const raw = event.args?.snapshot;
  if (raw?.version !== 1 || raw.supported !== true || raw.unsupported_count !== 0 ||
      (raw.unsupported !== undefined && (!Array.isArray(raw.unsupported) || raw.unsupported.length))) {
    throw new Error(`Unsupported native frame: ${raw?.unsupported?.join(', ') || 'schema'}`);
  }
  // Perfetto's JSON exporter can omit empty arrays; explicit native counts
  // distinguish an empty collection from a missing or incomplete snapshot.
  const entries = raw.entries ?? (raw.entry_count === 0 ? [] : null);
  const scrollOffsets = raw.scroll_offsets ?? (raw.scroll_count === 0 ? [] : null);
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length > FRAME_LIMITS.surfaces || raw.surfaces.length !== raw.surface_count ||
      !Array.isArray(entries) || entries.length !== raw.entry_count || entries.length > FRAME_LIMITS.layers ||
      !Array.isArray(scrollOffsets) || scrollOffsets.length !== raw.scroll_count ||
      !Array.isArray(raw.viewport) || raw.viewport.length !== 4 || raw.viewport[0] !== 0 || raw.viewport[1] !== 0) {
    throw new Error('Invalid native frame collections or viewport');
  }
  const surfaces = raw.surfaces.map(surface => ({ id: surface.id, rect: surface.content_rect, items: [] }));
  const targets = new Map(surfaces.map(surface => [surface.id, surface]));
  const resources = new Map(), fonts = new Map(), bytes = new Map();
  for (const entry of entries) {
    const target = targets.get(entry.target);
    if (!target) throw new Error('Native entry has no render target');
    const item = { kind: entry.kind, id: entry.id, transform: entry.transform,
      opacity: entry.opacity, clipped: entry.is_clipped, clip: entry.clip };
    if (entry.kind !== 'surface') item.bounds = entry.bounds;
    if (entry.kind === 'picture') {
      const record = entry.record;
      if (record?.font_error === true) throw new Error('Native font export failed');
      const dependencies = record?.fonts ?? (record?.font_count === 0 ? [] : null);
      // Legacy captures have embedded fonts. New exporters explicitly report
      // a complete external font inventory, including the empty case.
      if (record?.font_count !== undefined && (!Array.isArray(dependencies) ||
          dependencies.length !== record.font_count || record.font_error !== false)) throw new Error('Invalid native font inventory');
      const ids = [];
      for (const font of dependencies || []) {
        const descriptor = { kind: 'font', id: font.id, bytes: font.bytes, path: `fonts/${font.id}.font` };
        if (ids.includes(font.id) || fonts.has(font.id) && fonts.get(font.id).bytes !== font.bytes) throw new Error('Conflicting native font');
        fonts.set(font.id, descriptor); ids.push(font.id);
      }
      const encoded = entry.record?.skp64;
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(FRAME_LIMITS.resourceBytes / 3) * 4 ||
          !encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid native SKP base64');
      const data = Buffer.from(encoded, 'base64');
      if (data.length > FRAME_LIMITS.resourceBytes || data.subarray(0, 8).toString('ascii') !== 'skiapict') throw new Error('Invalid native SKP bytes');
      const id = createHash('sha256').update(data).digest('hex');
      const descriptor = { id, bytes: data.length, path: `pictures/${id}.skp`, ...(record?.font_count !== undefined ? { fonts: ids.sort() } : {}) };
      if (resources.has(id) && JSON.stringify(resources.get(id)) !== JSON.stringify(descriptor)) throw new Error('Changed picture font inventory');
      resources.set(id, descriptor);
      bytes.set(id, data); item.resource = id;
    } else if (entry.kind === 'solid') item.color = entry.color;
    target.items.push(item);
  }
  // cc traverses front to back; CanvasKit paints back to front per surface.
  for (const surface of surfaces) surface.items.reverse();
  const native = { pid: event.pid, treeId: raw.tree_id, ts: event.ts, sourceFrameNumber: raw.source_frame_number };
  const frame = validateFrame({ version: FRAME_VERSION, id: `${event.pid}:${raw.tree_id}:${event.ts}`, native,
    viewport: { width: raw.viewport[2], height: raw.viewport[3] }, background: raw.background,
    root: raw.root, surfaces, resources: [...fonts.values(), ...resources.values()], scrollOffsets });
  return { frame, bytes, fonts };
}

export function selectNativeFrame(events, { rendererPids, start, end, viewport }) {
  if (!Array.isArray(rendererPids) || !rendererPids.length || !(start < end)) throw new Error('Missing frame stage provenance');
  const candidates = events.flatMap((event, index) => event.name === 'VirtualDesktop.RemotePaintFrame' &&
    event.cat?.split(',').includes('cc') && rendererPids.includes(event.pid) && event.ts >= start && event.ts < end
    ? [{ event, index }] : []).sort((a, b) => a.event.ts - b.event.ts);
  const selected = candidates.at(-1);
  if (!selected) throw new Error('No authoritative native frame in this stage');
  // Never silently use an older supported frame when the newest is unsupported.
  const result = normalizeNativeFrame(selected.event);
  if (result.frame.viewport.width !== viewport.width || result.frame.viewport.height !== viewport.height) throw new Error('Latest native viewport differs from capture');
  return { ...result, eventIndex: selected.index, observedFrames: candidates.length };
}
