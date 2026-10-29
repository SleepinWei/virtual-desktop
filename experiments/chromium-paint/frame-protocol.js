// Complete native compositor snapshots. Independent of the v0 synthetic scene
// protocol: picture bytes are original SkPictures, fonts are independent binary
// resources, and geometry comes from cc.
export const FRAME_VERSION = 1;
export const FRAME_LIMITS = Object.freeze({ layers: 1024, surfaces: 64, depth: 32,
  resourceBytes: 32 * 1024 * 1024, fontBytes: 64 * 1024 * 1024,
  cacheBytes: 128 * 1024 * 1024, resources: 1024 });
const hash = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(`Invalid native frame: ${message}`); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const vector = (value, length) => Array.isArray(value) && value.length === length &&
  value.every(item => Number.isFinite(item) && Math.abs(item) <= 2 ** 20);
const rect = value => vector(value, 4) && value[2] >= 0 && value[3] >= 0;
const color = value => vector(value, 4) && value.every(item => item >= 0 && item <= 1);
const unique = values => new Set(values).size === values.length;

export function validateResource(resource) {
  const font = resource?.kind === 'font';
  if (!resource || !hash.test(resource.id) ||
      resource.kind !== undefined && !['font', 'picture'].includes(resource.kind) ||
      resource.path !== (font ? `fonts/${resource.id}.font` : `pictures/${resource.id}.skp`) ||
      !Number.isSafeInteger(resource.bytes) || resource.bytes < (font ? 12 : 8) ||
      resource.bytes > (font ? FRAME_LIMITS.fontBytes : FRAME_LIMITS.resourceBytes) ||
      font && resource.fonts !== undefined ||
      !font && resource.fonts !== undefined && (!Array.isArray(resource.fonts) ||
        resource.fonts.length > FRAME_LIMITS.resources || !unique(resource.fonts) || resource.fonts.some(id => !hash.test(id)))) {
    fail('resource descriptor');
  }
}

export function validateFrame(frame) {
  if (!frame || frame.version !== FRAME_VERSION || !/^[0-9:.]+$/.test(frame.id) || frame.id.length > 128 ||
      !integer(frame.native?.pid) || !integer(frame.native?.treeId) || !integer(frame.native?.sourceFrameNumber) ||
      !Number.isFinite(frame.native?.ts) || frame.native.ts < 0 ||
      frame.id !== `${frame.native.pid}:${frame.native.treeId}:${frame.native.ts}`) fail('identity');
  const { width, height } = frame.viewport || {};
  if (![width, height].every(value => integer(value) && value > 0 && value <= 4096) || !color(frame.background)) fail('viewport or background');
  if (!Array.isArray(frame.surfaces) || frame.surfaces.length < 1 || frame.surfaces.length > FRAME_LIMITS.surfaces ||
      !Array.isArray(frame.resources) || frame.resources.length > FRAME_LIMITS.resources) fail('collection limits');
  const resources = new Map();
  let bytes = 0;
  for (const resource of frame.resources) {
    validateResource(resource);
    if (resources.has(resource.id)) fail('duplicate resource');
    resources.set(resource.id, resource); bytes += resource.bytes;
  }
  const fontReferences = new Set();
  let picturesStarted = false;
  for (const resource of frame.resources) {
    if (resource.kind === 'font') {
      if (picturesStarted) fail('fonts must precede pictures');
    } else {
      picturesStarted = true;
      for (const id of resource.fonts || []) {
        if (resources.get(id)?.kind !== 'font') fail('missing font dependency');
        fontReferences.add(id);
      }
    }
  }
  if (frame.resources.some(resource => resource.kind === 'font' && !fontReferences.has(resource.id))) fail('orphan font');
  if (bytes > FRAME_LIMITS.cacheBytes) fail('frame resource budget');
  const surfaces = new Map(), layers = new Set(), referenced = new Set(), parents = new Map();
  for (const surface of frame.surfaces) {
    if (!integer(surface.id) || surfaces.has(surface.id) || !rect(surface.rect) || !Array.isArray(surface.items)) fail('surface');
    surfaces.set(surface.id, surface);
  }
  if (!surfaces.has(frame.root)) fail('missing root');
  let entries = 0;
  for (const surface of frame.surfaces) for (const item of surface.items) {
    if (++entries > FRAME_LIMITS.layers || !integer(item.id) || !vector(item.transform, 16) ||
        !rect(item.clip) || typeof item.clipped !== 'boolean' || !Number.isFinite(item.opacity) || item.opacity < 0 || item.opacity > 1) fail('entry');
    const m = item.transform;
    if ([2, 6, 8, 9, 11, 12, 13, 14].some(index => m[index] !== 0) || m[10] !== 1 || m[15] !== 1) fail('3D transform');
    if (item.kind === 'surface') {
      if (!surfaces.has(item.id) || item.id === frame.root || parents.has(item.id)) fail('surface reference');
      parents.set(item.id, surface.id);
    } else {
      if (layers.has(item.id) || !rect(item.bounds)) fail('duplicate layer or bounds');
      layers.add(item.id);
      if (item.kind === 'picture') {
        if (!resources.has(item.resource) || resources.get(item.resource).kind === 'font') fail('missing picture resource');
        referenced.add(item.resource);
      } else if (item.kind !== 'solid' || !color(item.color)) fail('unsupported layer');
    }
  }
  const visited = new Set();
  function visit(id, depth) {
    if (visited.has(id) || depth > FRAME_LIMITS.depth) fail('surface cycle or depth');
    visited.add(id);
    for (const item of surfaces.get(id).items) if (item.kind === 'surface') visit(item.id, depth + 1);
  }
  visit(frame.root, 0);
  if (visited.size !== surfaces.size || referenced.size + fontReferences.size !== resources.size) fail('orphan surface or resource');
  if (!Array.isArray(frame.scrollOffsets) || frame.scrollOffsets.length > FRAME_LIMITS.layers ||
      frame.scrollOffsets.some(item => typeof item.id !== 'string' || item.id.length > 128 || !vector(item.offset, 2)) ||
      !unique(frame.scrollOffsets.map(item => item.id))) fail('scroll offsets');
  return frame;
}

function validatePacket(packet, epoch) {
  if (packet?.version !== FRAME_VERSION || packet.kind !== 'frame' || packet.epoch !== epoch ||
      !integer(packet.seq) || packet.seq < 1 || !Array.isArray(packet.resources) ||
      !unique(packet.resources)) fail('packet identity or epoch');
  validateFrame(packet.frame);
  const available = new Set(packet.frame.resources.map(item => item.id));
  if (packet.resources.some(id => !available.has(id))) fail('packet resource list');
}

// At most two unacknowledged snapshots plus one coalesced newest snapshot.
// Only a presented ACK advertises client resources; sending a packet does not.
export class FrameChannel {
  constructor(epoch, { window = 2 } = {}) {
    if (typeof epoch !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(epoch) || ![1, 2].includes(window)) throw new TypeError('Invalid frame channel');
    this.epoch = epoch; this.window = window; this.seq = 0; this.acked = 0;
    this.pending = new Map(); this.known = new Map(); this.queued = null; this.coalesced = 0;
  }
  offer(frame) {
    frame = structuredClone(validateFrame(frame));
    if (this.pending.size >= this.window) {
      if (this.queued) this.coalesced++;
      this.queued = frame;
      return { status: 'queued' };
    }
    return { status: 'sent', packet: this.send(frame) };
  }
  send(frame) {
    const packet = { version: FRAME_VERSION, kind: 'frame', epoch: this.epoch, seq: ++this.seq,
      frame, resources: frame.resources.filter(item => !this.known.has(item.id)).map(item => item.id) };
    this.pending.set(packet.seq, structuredClone(packet));
    return packet;
  }
  acknowledge(ack) {
    if (ack?.version !== FRAME_VERSION || ack.kind !== 'presented' || ack.epoch !== this.epoch ||
        !integer(ack.seq) || ack.seq < 1) fail('ACK identity or epoch');
    if (ack.seq <= this.acked) return { accepted: false, reason: 'stale-ack' };
    const pending = this.pending.get(ack.seq);
    if (!pending || ack.frameId !== pending.frame.id || !Array.isArray(ack.resources) ||
        ack.resources.length > FRAME_LIMITS.resources || !unique(ack.resources)) fail('ACK does not match a sent frame');
    const offered = new Map(this.known);
    for (const [seq, packet] of this.pending) if (seq <= ack.seq) {
      for (const resource of packet.frame.resources) offered.set(resource.id, resource);
    }
    const retained = new Set(ack.resources);
    if (ack.resources.some(id => !offered.has(id)) || pending.frame.resources.some(item => !retained.has(item.id))) fail('ACK resource inventory');
    if (ack.resources.reduce((sum, id) => sum + offered.get(id).bytes, 0) > FRAME_LIMITS.cacheBytes) fail('ACK resource budget');
    this.known = new Map(ack.resources.map(id => [id, offered.get(id)])); this.acked = ack.seq;
    for (const seq of this.pending.keys()) if (seq <= ack.seq) this.pending.delete(seq);
    const queued = this.queued; this.queued = null;
    return { accepted: true, ...(queued ? { packet: this.send(queued) } : {}) };
  }
  get state() { return { epoch: this.epoch, sent: this.seq, acked: this.acked, pending: this.pending.size,
    queued: Boolean(this.queued), coalesced: this.coalesced, knownResources: this.known.size }; }
}

// load() must verify original bytes before decoding. present() is synchronous:
// draw into a private back buffer and replace visible pixels only on success.
export class FrameReceiver {
  constructor(epoch, { load, present, release, cacheBytes = FRAME_LIMITS.cacheBytes }) {
    if (![load, present, release].every(item => typeof item === 'function') ||
        !Number.isSafeInteger(cacheBytes) || cacheBytes < 8 || cacheBytes > FRAME_LIMITS.cacheBytes) throw new TypeError('Invalid receiver');
    this.load = load; this.present = present; this.release = release; this.budget = cacheBytes;
    this.cache = new Map(); this.generation = 0; this.presented = 0; this.stale = 0;
    this.reset(epoch);
  }
  reset(epoch) {
    if (typeof epoch !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(epoch)) throw new TypeError('Invalid receiver epoch');
    this.generation++;
    for (const entry of this.cache.values()) this.release(entry.value);
    this.cache.clear(); this.epoch = epoch; this.highest = 0; this.seq = 0; this.frame = null;
  }
  async receive(input) {
    const packet = structuredClone(input);
    validatePacket(packet, this.epoch);
    if (packet.seq <= this.highest) { this.stale++; return { status: 'stale' }; }
    if (packet.frame.resources.reduce((sum, item) => sum + item.bytes, 0) > this.budget) fail('receiver resource budget');
    this.highest = packet.seq;
    const generation = this.generation, created = new Map(), values = new Map();
    const current = () => generation === this.generation && packet.seq === this.highest;
    try {
      for (const resource of packet.frame.resources) {
        const cached = this.cache.get(resource.id);
        if (cached && (cached.resource.bytes !== resource.bytes || cached.resource.path !== resource.path ||
            cached.resource.kind !== resource.kind || JSON.stringify(cached.resource.fonts) !== JSON.stringify(resource.fonts))) fail('changed resource descriptor');
        const value = cached?.value ?? await this.load(resource);
        if (value == null) fail('resource decoder returned no value');
        if (!cached) created.set(resource.id, { resource, value });
        if (!current()) { this.stale++; return { status: 'stale' }; }
        values.set(resource.id, value);
      }
      if (!current()) { this.stale++; return { status: 'stale' }; }
      const result = this.present(packet.frame, values);
      if (result?.then) fail('present must be synchronous');
      const previousLayers = layerIds(this.frame), nextLayers = layerIds(packet.frame);
      this.seq = packet.seq; this.frame = packet.frame; this.presented++;
      for (const [id, entry] of created) this.cache.set(id, entry);
      created.clear();
      const active = new Set(values.keys());
      // Outline fonts preserve sparse native glyph IDs. A tiny serialized
      // subset may have a larger decoded index, so retire superseded fonts
      // and their pictures immediately instead of retaining many revisions.
      const retiredFonts = new Set([...this.cache].filter(([id, entry]) =>
        entry.resource.kind === 'font' && !active.has(id)).map(([id]) => id));
      for (const [id, entry] of this.cache) if (!active.has(id) &&
          (retiredFonts.has(id) || entry.resource.fonts?.some(font => retiredFonts.has(font)))) {
        this.release(entry.value); this.cache.delete(id);
      }
      // Keep current-frame resources first; old resources use the remaining
      // serialized-byte budget. This does not bound decoded WASM memory/RSS.
      // The ACK reports exactly what remains, including evictions.
      let retainedBytes = packet.frame.resources.reduce((sum, item) => sum + item.bytes, 0);
      for (const [id, entry] of this.cache) if (!active.has(id)) {
        if (retainedBytes + entry.resource.bytes > this.budget || this.cache.size > FRAME_LIMITS.resources) {
          this.release(entry.value); this.cache.delete(id);
        } else retainedBytes += entry.resource.bytes;
      }
      return { status: 'presented', removedLayerIds: [...previousLayers].filter(id => !nextLayers.has(id)),
        ack: { version: FRAME_VERSION, kind: 'presented', epoch: this.epoch, seq: this.seq,
          frameId: this.frame.id, resources: [...this.cache.keys()].sort() } };
    } finally { for (const entry of created.values()) this.release(entry.value); }
  }
  get state() { return { epoch: this.epoch, seq: this.seq, highest: this.highest, frameId: this.frame?.id ?? null,
    presented: this.presented, stale: this.stale, cachedResources: this.cache.size,
    cachedBytes: [...this.cache.values()].reduce((sum, item) => sum + item.resource.bytes, 0) }; }
}

export function layerIds(frame) {
  return new Set(frame?.surfaces.flatMap(surface => surface.items.filter(item => item.kind !== 'surface').map(item => item.id)) || []);
}
