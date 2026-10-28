import { FrameReceiver } from '/native/frame-protocol.js';
import { createFramePainter } from '/native/frame-renderer.js';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export class NativeClient {
  constructor({ kit, canvas, session, onControl, onStatus, onFrame }) {
    Object.assign(this, { kit, canvas, session, onControl, onStatus, onFrame });
    this.painter = createFramePainter(kit, canvas); this.generation = 0; this.attempts = 0;
    this.downloads = { resources: 0, bytes: 0 }; this.presented = null; this.stopped = false;
  }
  async call(operation, payload, signal) {
    const response = await fetch(`/api/sessions/${this.session.id}/frames/${operation}`, {
      method: payload === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${this.session.viewerToken}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      const result = await response.json(); throw Object.assign(new Error(result.error.message), { code: result.error.code });
    }
    return response;
  }
  async connect({ retry = false } = {}) {
    if (this.stopped) return;
    if (!retry) this.attempts = 0;
    const generation = ++this.generation, previousEpoch = this.epoch;
    this.abort?.abort(); this.abort = new AbortController(); this.presented = null;
    this.receiver?.reset('reconnecting');
    this.onStatus('connecting', 'Connecting to the running page…');
    if (previousEpoch) await this.call('disconnect', { epoch: previousEpoch }).catch(() => {});
    if (generation !== this.generation || this.stopped) return;
    try {
      const connection = await (await this.call('connect', {}, this.abort.signal)).json();
      if (generation !== this.generation || this.stopped) return;
      this.epoch = connection.epoch; this.onControl(connection.control);
      const signal = this.abort.signal, epoch = this.epoch;
      this.receiver = new FrameReceiver(epoch, {
        load: async resource => {
          const response = await this.call(`resources/${resource.id}?epoch=${epoch}`, undefined, signal);
          if (Number(response.headers.get('content-length') || resource.bytes) > resource.bytes) throw new Error('Resource exceeds its declared size');
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.length !== resource.bytes) throw new Error('Resource byte length mismatch');
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
          if (digest !== resource.id) throw new Error('Resource SHA-256 mismatch');
          const picture = this.kit.MakePicture(data);
          if (!picture) throw new Error('Native picture decoder rejected the frame');
          this.downloads.resources++; this.downloads.bytes += data.length;
          return picture;
        },
        present: (frame, pictures) => this.painter.present(frame, pictures), release: picture => picture.delete(),
      });
      const response = await this.call(`stream?epoch=${epoch}`, undefined, signal);
      this.read(response, generation).catch(error => this.recover(error, generation));
    } catch (error) { await this.recover(error, generation); }
  }
  async read(response, generation) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const result = await reader.read();
        if (generation !== this.generation || this.stopped) return;
        if (result.done) throw new Error('Frame connection closed');
        pending += decoder.decode(result.value, { stream: true });
        if (pending.length > 2 * 1024 * 1024) throw new Error('Frame metadata exceeds the client limit');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line) await this.consume(JSON.parse(line), generation);
          if (generation !== this.generation || this.stopped) return;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  async consume(packet, generation = this.generation) {
    if (generation !== this.generation || this.stopped) return;
    if (packet.control) this.onControl(packet.control);
    if (packet.kind === 'ping' || packet.kind === 'control') return;
    if (packet.kind === 'unsupported') throw Object.assign(new Error(packet.message), { code: packet.terminal ? 'SESSION_NOT_ACTIVE' : 'NATIVE_UNSUPPORTED' });
    const receiver = this.receiver, epoch = this.epoch;
    const result = await receiver.receive(packet);
    if (result.status !== 'presented' || generation !== this.generation || this.stopped) return;
    const acknowledged = await (await this.call('ack', result.ack, this.abort.signal)).json();
    if (generation !== this.generation || this.stopped || epoch !== this.epoch) return;
    this.onControl(acknowledged.control);
    if (!acknowledged.accepted) return;
    this.presented = { connectionEpoch: epoch, seq: packet.seq, frameId: packet.frame.id, revision: packet.frame.bridgeSeq };
    this.attempts = 0;
    this.onStatus('connected', 'Live page connected');
    this.onFrame({ ...this.presented, frame: packet.frame, receiver: receiver.state, downloads: { ...this.downloads },
      removedLayerIds: result.removedLayerIds });
  }
  async recover(error, generation) {
    if (generation !== this.generation || this.stopped || error.name === 'AbortError') return;
    this.presented = null; this.receiver?.reset('recovering'); this.abort?.abort();
    if (['SESSION_NOT_ACTIVE', 'SESSION_NOT_FOUND', 'FORBIDDEN'].includes(error.code)) {
      this.stopped = true; this.painter.dispose(); this.onStatus('ended', error.message); return;
    }
    if (error.code === 'NATIVE_UNSUPPORTED' || this.attempts >= 2) {
      const message = error.message === 'frame-too-large'
        ? 'This page uses fonts or content too large for native replay. Close the session and try a supported page.'
        : `${error.message}. Use reconnect after the page or connection recovers.`;
      this.onStatus('error', message); return;
    }
    this.onStatus('reconnecting', `${error.message}; restoring the latest frame…`);
    await wait([200, 600][this.attempts++]);
    if (generation === this.generation && !this.stopped) await this.connect({ retry: true });
  }
  async stop() {
    this.stopped = true; this.generation++; this.presented = null; this.abort?.abort();
    this.receiver?.reset('stopped'); this.painter.dispose();
    if (this.epoch) await this.call('disconnect', { epoch: this.epoch }).catch(() => {});
  }
  get state() { return { epoch: this.epoch, generation: this.generation, presented: this.presented,
    receiver: this.receiver?.state, downloads: { ...this.downloads } }; }
}
