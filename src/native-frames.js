import { randomUUID, createHash } from 'node:crypto';
import { FrameChannel, FRAME_LIMITS, validateFrame } from '../experiments/chromium-paint/frame-protocol.js';
import { AppError, ensure } from './errors.js';
import { openNativeFont } from './native-font-file.js';

export function visualSignature(frame) {
  return createHash('sha256').update(JSON.stringify({ viewport: frame.viewport, background: frame.background,
    root: frame.root, surfaces: frame.surfaces, scrollOffsets: frame.scrollOffsets })).digest('hex');
}

// Owns the newest complete frame and the resources pinned by live in-flight
// packets. Browser lifetime is independent of any viewer connection.
export class NativeFrames {
  constructor(control) {
    this.control = control; this.revision = 0; this.latest = null; this.fault = null;
    this.resources = new Map(); this.connections = new Map(); this.received = 0; this.duplicates = 0;
  }
  ingest({ frame, resources }) {
    validateFrame(frame);
    ensure(Array.isArray(resources) && resources.length === frame.resources.length, 500, 'NATIVE_RESOURCE_ERROR', 'Native resource inventory is incomplete');
    const incoming = new Map();
    try {
      for (const entry of resources) {
        const descriptor = frame.resources.find(resource => resource.id === entry.id), data = entry.data;
        ensure(descriptor && !incoming.has(entry.id), 500, 'NATIVE_RESOURCE_ERROR', 'Native resource inventory does not match');
        if (descriptor.kind === 'font') {
          ensure(data === undefined, 500, 'NATIVE_RESOURCE_ERROR', 'Font bytes must use the binary asset store');
          ensure(!this.resources.has(entry.id) || this.resources.get(entry.id).length === descriptor.bytes,
            500, 'NATIVE_RESOURCE_ERROR', 'Changed native font length');
          // Previously verified assets are immutable and pinned by open inode.
          incoming.set(entry.id, this.resources.get(entry.id) || openNativeFont(entry.filePath, descriptor));
        } else {
          ensure(Buffer.isBuffer(data) && data.length === descriptor.bytes &&
            createHash('sha256').update(data).digest('hex') === descriptor.id,
          500, 'NATIVE_RESOURCE_ERROR', 'Native resource bytes do not match');
          incoming.set(entry.id, data);
        }
      }
    } catch (error) {
      for (const [id, data] of incoming) if (!this.resources.has(id)) data.close?.();
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'NATIVE_RESOURCE_ERROR', error.message);
    }
    this.received++;
    const signature = visualSignature(frame);
    if (!this.fault && this.latest?.signature === signature) {
      for (const [id, data] of incoming) if (!this.resources.has(id)) data.close?.();
      this.duplicates++; return;
    }
    this.latest = { frame: { ...structuredClone(frame), bridgeSeq: ++this.revision }, signature };
    this.fault = null;
    for (const [id, data] of incoming) if (!this.resources.has(id)) this.resources.set(id, data);
    for (const connection of this.connections.values()) {
      if (!connection.send) continue;
      const offered = connection.channel.offer(this.latest.frame);
      if (offered.packet) this.deliver(connection, offered.packet);
    }
    this.prune();
  }
  unsupported(message, terminal = false) {
    this.latest = null; this.fault = String(message).slice(0, 240);
    for (const connection of [...this.connections.values()]) {
      connection.send?.({ kind: 'unsupported', message: this.fault, terminal, control: this.control() });
      this.disconnect(connection.epoch);
    }
    this.prune();
  }
  connect(role) {
    ensure(this.latest && !this.fault, 409, 'NATIVE_FRAME_UNAVAILABLE', this.fault || 'Native page has not produced a supported frame');
    ensure(this.connections.size < 4, 429, 'VIEWER_LIMIT', 'At most four native viewers are permitted');
    const epoch = randomUUID(), channel = new FrameChannel(epoch);
    const connection = { epoch, role, channel, send: null, close: null, presented: null, presentations: new Map() };
    connection.timer = setTimeout(() => this.disconnect(epoch), 15000); connection.timer.unref();
    this.connections.set(epoch, connection);
    return { epoch, revision: this.revision, control: this.control() };
  }
  get(epoch, role) {
    const connection = this.connections.get(epoch);
    ensure(connection && connection.role === role, 410, 'FRAME_CONNECTION_GONE', 'Frame connection expired; reconnect for a fresh snapshot');
    return connection;
  }
  attach(epoch, role, send, close) {
    const connection = this.get(epoch, role);
    ensure(this.latest && !this.fault, 409, 'NATIVE_FRAME_UNAVAILABLE', 'No supported native frame is available');
    ensure(!connection.send, 409, 'FRAME_CONNECTION_BUSY', 'Frame stream is already attached');
    clearTimeout(connection.timer);
    connection.send = send; connection.close = close;
    const offered = connection.channel.offer(this.latest.frame);
    this.deliver(connection, offered.packet);
    return () => this.disconnect(epoch);
  }
  deliver(connection, packet) {
    const message = { ...packet, control: this.control() };
    connection.send?.(message);
  }
  acknowledge(ack, role) {
    const connection = this.get(ack?.epoch, role), packet = connection.channel.pending.get(ack.seq);
    let result;
    try { result = connection.channel.acknowledge(ack); }
    catch { throw new AppError(400, 'INVALID_FRAME_ACK', 'ACK does not match the offered native frame and resource inventory'); }
    if (result.accepted) {
      connection.presented = { seq: ack.seq, frameId: packet.frame.id,
        revision: packet.frame.bridgeSeq, signature: visualSignature(packet.frame) };
      connection.presentations.set(ack.seq, connection.presented);
      if (connection.presentations.size > 16) connection.presentations.delete(connection.presentations.keys().next().value);
    }
    if (result.packet) this.deliver(connection, result.packet);
    this.prune();
    return { accepted: result.accepted, channel: connection.channel.state, control: this.control() };
  }
  resource(epoch, role, id) {
    const connection = this.get(epoch, role);
    ensure([...connection.channel.pending.values()].some(packet => packet.frame.resources.some(resource => resource.id === id)),
      404, 'RESOURCE_NOT_OFFERED', 'Resource is not referenced by an in-flight frame');
    const bytes = this.resources.get(id);
    ensure(bytes, 410, 'RESOURCE_EVICTED', 'Reconnect for a fresh resource snapshot');
    return bytes;
  }
  assertPresented(action, requireCurrent = true) {
    ensure(!this.fault && this.latest, 409, 'NATIVE_FRAME_UNAVAILABLE', 'A current supported frame is required');
    const connection = this.connections.get(action.connectionEpoch), presented = connection?.presentations.get(action.seq);
    ensure(presented && action.seq === presented.seq && action.frameId === presented.frameId &&
      (!requireCurrent || presented.signature === this.latest.signature), 409, 'STALE_FRAME', 'The displayed frame changed; wait for the next presented frame');
    return this.latest.signature;
  }
  assertPointer(action) { return this.assertPresented(action); }
  disconnect(epoch) {
    const connection = this.connections.get(epoch);
    if (!connection) return;
    this.connections.delete(epoch); clearTimeout(connection.timer); connection.close?.(); this.prune();
  }
  controlChanged() {
    for (const connection of this.connections.values()) connection.send?.({ kind: 'control', control: this.control() });
  }
  prune() {
    const pinned = new Set(this.latest?.frame.resources.map(resource => resource.id) || []);
    for (const { channel } of this.connections.values()) {
      for (const packet of channel.pending.values()) for (const resource of packet.frame.resources) pinned.add(resource.id);
      for (const resource of channel.queued?.resources || []) pinned.add(resource.id);
    }
    for (const [id, data] of this.resources) if (!pinned.has(id)) { data.close?.(); this.resources.delete(id); }
    // The cap includes bytes pinned by all viewers, not just the newest frame.
    if (this.bytes > FRAME_LIMITS.cacheBytes) {
      for (const epoch of [...this.connections.keys()]) this.disconnect(epoch);
      const active = new Set(this.latest?.frame.resources.map(resource => resource.id) || []);
      for (const [id, data] of this.resources) if (!active.has(id)) { data.close?.(); this.resources.delete(id); }
    }
  }
  get bytes() { return [...this.resources.values()].reduce((sum, value) => sum + value.length, 0); }
  get stats() { return { revision: this.revision, received: this.received, duplicates: this.duplicates,
    resourceBytes: this.bytes, resources: this.resources.size, fault: this.fault,
    frameId: this.latest?.frame.id ?? null, connections: [...this.connections.values()].map(connection => connection.channel.state) }; }
  close() {
    for (const epoch of [...this.connections.keys()]) this.disconnect(epoch);
    this.latest = null;
    for (const data of this.resources.values()) data.close?.();
    this.resources.clear();
  }
}
