import { FRAME_LIMITS, validateResource } from './frame-protocol.js';

// The registry belongs to one viewer. Fonts and original compressed images
// use binary capabilities; only the viewer decodes image pixels.
export function createNativeDecoder(kit, { fetchResource, downloads = { resources: 0, bytes: 0 } }) {
  const fonts = new Map(), images = new Map(), pending = new Map();
  let registry, closed = false, imageCacheConfigured = false;
  const active = () => { if (closed) throw new Error('Native font runtime is closed'); };
  const getRegistry = () => {
    if (!kit.RemoteFontRegistry) throw new Error('This CanvasKit runtime does not support external assets');
    return registry ||= new kit.RemoteFontRegistry();
  };
  async function bytes(resource) {
    const response = await fetchResource(resource);
    if (!response.ok || Number(response.headers.get('content-length') || resource.bytes) > resource.bytes) throw new Error('Resource request failed or exceeds its declared size');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== resource.bytes) throw new Error('Resource byte length mismatch');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== resource.id) throw new Error('Resource SHA-256 mismatch');
    active(); downloads.resources++; downloads.bytes += data.length;
    if (['font', 'image'].includes(resource.kind)) {
      downloads[resource.kind + 's'] = (downloads[resource.kind + 's'] || 0) + 1;
      downloads[resource.kind + 'Bytes'] = (downloads[resource.kind + 'Bytes'] || 0) + data.length;
    }
    return data;
  }
  function own(data, consume) {
    const pointer = kit._malloc(data.length);
    if (!pointer) throw new Error('Native font runtime allocation failed');
    try { kit.HEAPU8.set(data, pointer); }
    catch (error) { kit._free(pointer); throw error; }
    // C++ takes ownership even when decoding fails.
    return consume(pointer, data.length);
  }
  const imageBytes = () => [...images.values()].reduce((sum, entry) => sum + entry.storedBytes, 0);
  function rejectAnimated(data, firstFrame) {
    const ascii = (start, count) => String.fromCharCode(...data.subarray(start, start + count));
    if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let at = 8, count = 0; at + 12 <= data.length; count++) {
        if (count >= 4096) throw new Error('Excessive image metadata');
        const length = view.getUint32(at), end = at + 12 + length;
        if (end > data.length) break; // Strict codec validation handles truncation.
        if (!firstFrame && ascii(at + 4, 4) === 'acTL' && length >= 8 && view.getUint32(at + 8) > 1) throw new Error('Animated images are not supported');
        at = end;
      }
    }
    if (ascii(4, 4) === 'ftyp') {
      const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      // Do not ignore brands past the bounded parser: that could turn an
      // animated AVIF into an apparently static first-frame preview.
      if (size < 16 || size > data.length || size > 128 || size % 4) throw new Error('Invalid or excessive image metadata');
      for (let at = 8; at + 4 <= Math.min(size, data.length, 128); at += 4) {
        if (!firstFrame && ascii(at, 4) === 'avis') throw new Error('Animated images are not supported');
      }
    }
  }
  async function registerImage(data, resource, runtime) {
    if (!runtime._addEncodedImage || !kit.setDecodeCacheLimitBytes) throw new Error('This CanvasKit runtime does not support bounded external images');
    if (!imageCacheConfigured) { kit.setDecodeCacheLimitBytes(FRAME_LIMITS.imageDecodeCacheBytes); imageCacheConfigured = true; }
    const firstFrame = resource.animationPolicy === 'first-frame';
    rejectAnimated(data, firstFrame);
    const add = input => {
      active();
      return own(input, (pointer, length) => runtime._addEncodedImage(resource.id, pointer, length, resource.width, resource.height, firstFrame));
    };
    const registered = add(data);
    if (registered === 1) return data.length;
    if (registered !== 0) throw new Error('Native image registry rejected the asset, dimensions or budget');
    // The small Skia codec build omits AVIF. Transcode unsupported formats
    // locally to a compressed PNG, then keep a lazy SkImage rather than a
    // persistent RGBA bitmap. Release the browser's pixels before registration.
    const brand = String.fromCharCode(...data.subarray(4, 8));
    const brands = [];
    if (brand === 'ftyp') {
      const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      for (let at = 8; at + 4 <= Math.min(size, data.length, 128); at += 4) brands.push(String.fromCharCode(...data.subarray(at, at + 4)));
    }
    if (!(brands.includes('avif') || firstFrame && brands.includes('avis')) || typeof createImageBitmap !== 'function') throw new Error('Local image decoder rejected the original image');
    const bitmap = await createImageBitmap(new Blob([data]), { imageOrientation: 'none' });
    let canvas, png;
    try {
      active();
      if (bitmap.width !== resource.width || bitmap.height !== resource.height) throw new Error('Native image dimensions do not match');
      canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bitmap.width, bitmap.height) : document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
        : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Local PNG encoding failed')), 'image/png'));
      active(); png = new Uint8Array(await blob.arrayBuffer());
    } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 0; }
    if (png.length > FRAME_LIMITS.imageBytes || add(png) !== 1) throw new Error('Native image registry rejected the local codec result');
    return png.length;
  }
  async function asset(resource) {
    const table = resource.kind === 'font' ? fonts : images;
    let entry = table.get(resource.id);
    if (!entry) {
      const key = resource.kind + ':' + resource.id;
      let loading = pending.get(key);
      if (!loading) {
        loading = (async () => {
          const data = await bytes(resource);
          active();
          const runtime = getRegistry();
          let storedBytes = resource.bytes;
          if (resource.kind === 'font') {
            if (!own(data, (pointer, length) => runtime._addFont(resource.id, pointer, length))) throw new Error('Native font registry rejected the asset');
          } else storedBytes = await registerImage(data, resource, runtime);
          active();
          const value = { bytes: resource.bytes, width: resource.width, height: resource.height, animationPolicy: resource.animationPolicy, storedBytes, refs: 0 };
          table.set(resource.id, value); return value;
        })();
        pending.set(key, loading);
      }
      try { entry = await loading; }
      finally { if (pending.get(key) === loading) pending.delete(key); }
    }
    active();
    if (entry.bytes !== resource.bytes || entry.width !== resource.width || entry.height !== resource.height || entry.animationPolicy !== resource.animationPolicy) throw new Error('Changed native asset descriptor');
    entry.refs++;
    return { kind: resource.kind, id: resource.id };
  }
  return {
    async load(resource) {
      active(); validateResource(resource);
      if (['font', 'image'].includes(resource.kind)) return asset(resource);
      if (resource.fonts?.some(id => !fonts.has(id))) throw new Error('Missing native font dependency');
      if (resource.images?.some(id => !images.has(id))) throw new Error('Missing native image dependency');
      const data = await bytes(resource);
      active();
      const picture = resource.fonts !== undefined || resource.images !== undefined
        ? own(data, (pointer, length) => getRegistry()._makePicture(pointer, length)) : kit.MakePicture(data);
      if (!picture) throw new Error('Native picture decoder rejected the frame or its assets');
      return picture;
    },
    release(value) {
      if (!['font', 'image'].includes(value.kind)) { value.delete(); return; }
      const table = value.kind === 'font' ? fonts : images, entry = table.get(value.id);
      if (entry && --entry.refs === 0) {
        if (value.kind === 'font') registry.removeFont(value.id); else registry.removeImage(value.id);
        table.delete(value.id);
      }
    },
    dispose() { closed = true; registry?.delete(); registry = null; fonts.clear(); images.clear(); },
    get state() { return { fonts: fonts.size, fontBytes: [...fonts.values()].reduce((sum, entry) => sum + entry.bytes, 0),
      images: images.size, encodedImageBytes: imageBytes(), imageDecodeCacheBytes: imageCacheConfigured ? FRAME_LIMITS.imageDecodeCacheBytes : 0,
      imageDecodeCacheUsedBytes: imageCacheConfigured ? kit.getDecodeCacheUsedBytes?.() ?? null : 0 }; },
  };
}
