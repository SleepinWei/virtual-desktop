import { FrameReceiver } from '/native/frame-protocol.js';
import { createFramePainter } from '/native/frame-renderer.js';
import { createNativeDecoder } from '/native/font-runtime.js';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export class NativeClient {
  constructor({ kit, canvas, session, onControl, onStatus, onFrame }) {
    Object.assign(this, { kit, canvas, session, onControl, onStatus, onFrame });
    this.painter = createFramePainter(kit, canvas); this.generation = 0; this.attempts = 0;
    this.downloads = { resources: 0, bytes: 0 }; this.presented = null; this.coordinateReady = false; this.stopped = false;
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
    this.abort?.abort(); this.abort = new AbortController(); this.presented = null; this.coordinateReady = false;
    this.receiver?.reset('reconnecting');
    this.decoder?.dispose();
    this.onStatus('connecting', 'Connecting to the running page…');
    if (previousEpoch) await this.call('disconnect', { epoch: previousEpoch }).catch(() => {});
    if (generation !== this.generation || this.stopped) return;
    try {
      const connection = await (await this.call('connect', {}, this.abort.signal)).json();
      if (generation !== this.generation || this.stopped) return;
      this.epoch = connection.epoch; this.onControl(connection.control);
      const signal = this.abort.signal, epoch = this.epoch;
      if (!this.runtimeFonts) {
        const response = await fetch('/native-runtime/runtime.json', { signal });
        if (!response.ok) throw new Error('Native runtime metadata is unavailable');
        const metadata = await response.json();
        this.runtimeFonts = new Map((metadata.fonts || []).map(font => [font.id, font]));
      }
      if (generation !== this.generation || this.stopped) return;
      this.decoder = createNativeDecoder(this.kit, {
        fetchResource: resource => {
          if (resource.kind === 'font' && this.runtimeFonts.get(resource.id)?.bytes === resource.bytes) {
            this.downloads.preinstalledFonts = (this.downloads.preinstalledFonts || 0) + 1;
            return fetch('/native-runtime/' + resource.path, { signal });
          }
          return this.call(`resources/${resource.id}?epoch=${epoch}`, undefined, signal);
        }, downloads: this.downloads,
      });
      this.receiver = new FrameReceiver(epoch, {
        load: this.decoder.load,
        present: (frame, pictures) => this.painter.present(frame, pictures), release: this.decoder.release,
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
    this.coordinateReady = false;
    if (packet.kind === 'unsupported') throw Object.assign(new Error(packet.message), { code: packet.terminal ? 'SESSION_NOT_ACTIVE' : 'NATIVE_UNSUPPORTED' });
    const receiver = this.receiver, epoch = this.epoch;
    const result = await receiver.receive(packet);
    if (result.status !== 'presented' || generation !== this.generation || this.stopped) return;
    const acknowledged = await (await this.call('ack', result.ack, this.abort.signal)).json();
    if (generation !== this.generation || this.stopped || epoch !== this.epoch) return;
    this.onControl(acknowledged.control);
    if (!acknowledged.accepted) return;
    this.presented = { connectionEpoch: epoch, seq: packet.seq, frameId: packet.frame.id, revision: packet.frame.bridgeSeq };
    this.coordinateReady = acknowledged.current === true;
    this.attempts = 0;
    this.onStatus('connected', this.coordinateReady ? 'Live page connected' : 'Live page connected · catching up');
    this.onFrame({ ...this.presented, frame: packet.frame, receiver: receiver.state, downloads: { ...this.downloads },
      removedLayerIds: result.removedLayerIds });
  }
  async recover(error, generation) {
    if (generation !== this.generation || this.stopped || error.name === 'AbortError') return;
    this.presented = null; this.coordinateReady = false; this.receiver?.reset('recovering'); this.abort?.abort(); this.decoder?.dispose();
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
    this.stopped = true; this.generation++; this.presented = null; this.coordinateReady = false; this.abort?.abort();
    this.receiver?.reset('stopped'); this.decoder?.dispose(); this.painter.dispose();
    if (this.epoch) await this.call('disconnect', { epoch: this.epoch }).catch(() => {});
  }
  get state() { return { epoch: this.epoch, generation: this.generation, presented: this.presented, coordinateReady: this.coordinateReady,
    receiver: this.receiver?.state, decoder: this.decoder?.state, downloads: { ...this.downloads } }; }
}
