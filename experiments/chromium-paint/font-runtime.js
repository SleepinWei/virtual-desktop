import { validateResource } from './frame-protocol.js';

// Font programs are independent binary runtime assets. Frame JSON and SKPs
// contain IDs/instance descriptors only. A decoder belongs to one viewer so
// private webfonts cannot escape its capability or live beyond its lifetime.
export function createNativeDecoder(kit, { fetchResource, downloads = { resources: 0, bytes: 0 } }) {
  const fonts = new Map(), pending = new Map();
  let registry, closed = false;
  const active = () => { if (closed) throw new Error('Native font runtime is closed'); };
  async function bytes(resource) {
    const response = await fetchResource(resource);
    if (!response.ok || Number(response.headers.get('content-length') || resource.bytes) > resource.bytes) throw new Error('Resource request failed or exceeds its declared size');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== resource.bytes) throw new Error('Resource byte length mismatch');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== resource.id) throw new Error('Resource SHA-256 mismatch');
    active(); downloads.resources++; downloads.bytes += data.length;
    if (resource.kind === 'font') {
      downloads.fonts = (downloads.fonts || 0) + 1;
      downloads.fontBytes = (downloads.fontBytes || 0) + data.length;
    }
    return data;
  }
  function own(data, consume) {
    const pointer = kit._malloc(data.length);
    if (!pointer) throw new Error('Native font runtime allocation failed');
    try { kit.HEAPU8.set(data, pointer); }
    catch (error) { kit._free(pointer); throw error; }
    // Both C++ entry points take ownership even when decoding fails.
    return consume(pointer, data.length);
  }
  async function font(resource) {
    let entry = fonts.get(resource.id);
    if (!entry) {
      let loading = pending.get(resource.id);
      if (!loading) {
        loading = (async () => {
          const data = await bytes(resource);
          active();
          if (!kit.RemoteFontRegistry) throw new Error('This CanvasKit runtime does not support external fonts');
          registry ||= new kit.RemoteFontRegistry();
          if (!own(data, (pointer, length) => registry._addFont(resource.id, pointer, length))) throw new Error('Native font registry rejected the asset');
          const value = { bytes: resource.bytes, refs: 0 };
          fonts.set(resource.id, value); return value;
        })();
        pending.set(resource.id, loading);
      }
      try { entry = await loading; }
      finally { if (pending.get(resource.id) === loading) pending.delete(resource.id); }
    }
    active();
    if (entry.bytes !== resource.bytes) throw new Error('Changed native font descriptor');
    entry.refs++;
    return { kind: 'font', id: resource.id };
  }
  return {
    async load(resource) {
      active(); validateResource(resource);
      if (resource.kind === 'font') return font(resource);
      if (resource.fonts?.some(id => !fonts.has(id))) throw new Error('Missing native font dependency');
      const data = await bytes(resource);
      active();
      const picture = resource.fonts?.length
        ? own(data, (pointer, length) => registry._makePicture(pointer, length)) : kit.MakePicture(data);
      if (!picture) throw new Error('Native picture decoder rejected the frame or its fonts');
      return picture;
    },
    release(value) {
      if (value.kind !== 'font') { value.delete(); return; }
      const entry = fonts.get(value.id);
      if (entry && --entry.refs === 0) { registry.removeFont(value.id); fonts.delete(value.id); }
    },
    dispose() { closed = true; registry?.delete(); registry = null; fonts.clear(); },
    get state() { return { fonts: fonts.size, fontBytes: [...fonts.values()].reduce((sum, entry) => sum + entry.bytes, 0) }; },
  };
}
