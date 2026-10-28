import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { verifiedEngine } from './verified.js';
import { createNativeStream } from './native-stream.js';
import { captureLaunchArgs, loopbackUrl } from '../chromium-paint/capture.js';
import { ensure } from '../../src/errors.js';

// A privileged in-process router for the bounded local experiment. Raw frames
// are never broadcast to viewers. A renderer may belong to only one lease.
export class NativeLeaseRouter {
  constructor({ maxActive = 2, maxRetired = 64 } = {}) {
    this.maxActive = maxActive; this.maxRetired = maxRetired;
    this.leases = new Map(); this.routes = new Map(); this.renderers = new Map(); this.retired = new Set();
    this.received = 0; this.delivered = 0; this.dropped = 0;
  }
  attach(id, receive, fault) {
    ensure(typeof id === 'string' && id.length <= 64 && !this.leases.has(id), 409, 'LEASE_EXISTS', 'Invalid or duplicate lease');
    ensure(this.leases.size < this.maxActive && this.retired.size < this.maxRetired, 429, 'POOL_LIMIT', 'Native pool must drain or recycle');
    this.leases.set(id, { receive, fault, route: null });
  }
  bind(id, { pid, treeId }) {
    const lease = this.leases.get(id), key = `${pid}:${treeId}`;
    ensure(lease && Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(treeId) && treeId > 0,
      409, 'INVALID_NATIVE_LEASE', 'Invalid native lease identity');
    ensure(!this.retired.has(key), 409, 'RETIRED_NATIVE_ROUTE', 'A retired native route cannot be leased again');
    ensure(!this.renderers.has(pid) || this.renderers.get(pid) === id,
      409, 'RENDERER_ALREADY_LEASED', 'Do not share a renderer between sessions');
    ensure(!lease.route || lease.route.key === key, 409, 'NATIVE_ROUTE_CHANGED', 'A native lease cannot change its widget');
    lease.route = { pid, treeId, key }; this.routes.set(key, id); this.renderers.set(pid, id);
  }
  detach(id) {
    const lease = this.leases.get(id); if (!lease) return;
    if (lease.route) {
      this.routes.delete(lease.route.key); this.renderers.delete(lease.route.pid); this.retired.add(lease.route.key);
    }
    this.leases.delete(id);
  }
  receive(message) {
    this.received++;
    const key = `${message.pid}:${message.snapshot?.tree_id}`;
    if (this.retired.has(key)) { this.dropped++; return; }
    const id = this.renderers.get(message.pid);
    if (id) {
      const lease = this.leases.get(id);
      // Keep widget validation in ChromiumSession.receive, including faults
      // that have a pid but no snapshot/tree ID.
      lease.receive(message); this.delivered++; return;
    }
    let delivered = false;
    for (const lease of this.leases.values()) if (!lease.route) { lease.receive(message); delivered = true; }
    if (!delivered) this.dropped++;
  }
  fail(message) { for (const lease of this.leases.values()) lease.fault(message, true); }
  get stats() { return { active: this.leases.size, bound: this.routes.size, retired: this.retired.size,
    received: this.received, delivered: this.delivered, dropped: this.dropped }; }
}

export class SharedChromiumHost {
  constructor({ onBrowser = () => {}, maxActive = 2 } = {}) {
    this.onBrowser = onBrowser; this.router = new NativeLeaseRouter({ maxActive });
    this.traceChain = Promise.resolve(); this.closed = false; this.diagnostics = '';
  }
  async start({ root, expectedArtifactsSha256, expectedPatchSha256 }) {
    ensure(!this.browser, 409, 'HOST_STARTED', 'Browser host is already started');
    const engine = await verifiedEngine(root, { requireStream: true });
    ensure(engine.artifactsSha256 === expectedArtifactsSha256 && engine.patchSha256 === expectedPatchSha256,
      409, 'ENGINE_CHANGED', 'Browser host requires the pinned runtime');
    this.engine = engine;
    this.stream = await createNativeStream(message => this.router.receive(message));
    try {
      this.server = await chromium.launchServer({ executablePath: engine.binary, headless: true, host: '127.0.0.1', timeout: 15000,
        chromiumSandbox: false, args: captureLaunchArgs({ remotePaint: true, noDisplay: true, producerBufferBytes: 8388608 }),
        env: { ...process.env, ...this.stream.environment } });
      this.browserPid = this.server.process().pid; this.onBrowser(this.browserPid, this.server.process());
      this.server.process().stderr?.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk.toString()).slice(-16384); });
      this.browser = await chromium.connect(this.server.wsEndpoint());
      this.browser.on('disconnected', () => { if (!this.closed) this.router.fail('Shared browser disconnected; all host leases stopped'); });
      return { browserPid: this.browserPid, artifactsSha256: engine.artifactsSha256 };
    } catch (error) { await this.close(); throw error; }
  }
  attach(session, parameters) {
    ensure(!this.closed && this.browser?.isConnected(), 503, 'HOST_UNAVAILABLE', 'Shared browser is not connected');
    ensure(resolve(parameters.root) === this.engine.root && parameters.expectedArtifactsSha256 === this.engine.artifactsSha256 &&
      parameters.expectedPatchSha256 === this.engine.patchSha256, 409, 'ENGINE_CHANGED', 'Lease runtime differs from the pinned host');
    ensure(!parameters.site, 400, 'POOL_FIXTURE_ONLY', 'Shared native host currently supports trusted local fixtures only');
    loopbackUrl(parameters.url);
    this.router.attach(session.leaseId, message => session.receive(message), (message, fatal) => session.onFault(message, fatal));
    return { browser: this.browser, browserPid: this.browserPid, stream: this.stream };
  }
  trace(operation) {
    const result = this.traceChain.then(() => {
      ensure(!this.closed && this.browser?.isConnected(), 503, 'HOST_UNAVAILABLE', 'Shared browser is not connected');
      return operation();
    });
    this.traceChain = result.catch(() => {}); return result;
  }
  async close() {
    if (this.closed) return; this.closed = true;
    this.router.fail('Shared browser host closed');
    await this.server?.close().catch(() => {}); await this.stream?.close();
  }
}
