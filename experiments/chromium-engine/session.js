import { chromium } from 'playwright';
import { verifiedEngine } from './verified.js';
import { createNativeStream } from './native-stream.js';
import { browserAction } from './browser-actions.js';
import { allowedSiteRequest, externalSites } from './sites.js';
import { captureLaunchArgs, findPageProvenance, recordTrace, settlePage } from '../chromium-paint/capture.js';
import { normalizeNativeFrame } from '../chromium-paint/native-frame.js';
import { visualSignature } from '../../src/native-frames.js';
import { ensure } from '../../src/errors.js';
import { randomUUID } from 'node:crypto';
import { nativePageRoute } from './page-route.js';

const STARTUP_TRACE = { recordMode: 'recordAsMuchAsPossible', traceBufferSizeInKb: 4096,
  includedCategories: ['disabled-by-default-devtools.timeline'], excludedCategories: ['*'] };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class ChromiumSession {
  constructor({ onFrame, onFault, onBrowser, sharedHost, onPage }) {
    this.onFrame = onFrame; this.onFault = onFault; this.onBrowser = onBrowser;
    this.candidates = new Map(); this.actions = new Map(); this.frames = 0; this.excluded = 0;
    this.latest = null; this.route = null; this.closed = false; this.traceActive = false;
    this.sharedHost = sharedHost; this.leaseId = randomUUID();
    this.onPage = onPage;
  }
  async start({ root, expectedArtifactsSha256, expectedPatchSha256, url, viewport, saved, allowedPaths, site }) {
    const verified = this.sharedHost?.engine || await verifiedEngine(root, { requireStream: true });
    ensure(verified.artifactsSha256 === expectedArtifactsSha256 && verified.patchSha256 === expectedPatchSha256,
      409, 'ENGINE_CHANGED', 'Native build changed; restart the service before creating sessions');
    ensure(!site || externalSites[site] && allowedSiteRequest(site, url, { navigation: true }), 400, 'INVALID_SITE', 'Unknown external site');
    this.viewport = viewport; this.url = url; this.site = site;
    if (saved) ensure(saved.kind === 'chromium-storage-v1' && saved.storageState && Array.isArray(saved.storageState.cookies) &&
      Array.isArray(saved.storageState.origins), 409, 'INVALID_PROFILE_STATE', 'Expected a Chromium storage profile');
    if (this.sharedHost) {
      const shared = this.sharedHost.attach(this, { root, expectedArtifactsSha256, expectedPatchSha256, site, url });
      this.browser = shared.browser; this.browserPid = shared.browserPid; this.stream = shared.stream;
      // The startup metadata trace is browser-wide. A per-lease URL prevents
      // two contexts at the same fixture URL from claiming each other's pid.
      const unique = new URL(url); unique.searchParams.set('vd_native_lease', this.leaseId);
      url = unique.href; this.url = url;
    } else {
      this.stream = await createNativeStream(message => this.receive(message));
      this.server = await chromium.launchServer({ executablePath: verified.binary, headless: true, host: '127.0.0.1', timeout: 15000,
        // Cross-site process launches serialize tracing shared memory through an
        // upstream switch capped at 8 MiB. Live frames do not use trace transport.
        chromiumSandbox: false, args: captureLaunchArgs({ remotePaint: true, noDisplay: true, producerBufferBytes: 8388608 }),
        env: { ...process.env, ...this.stream.environment } });
      this.browserPid = this.server.process().pid; this.onBrowser(this.browserPid, this.server.process());
      let diagnosticBytes = 0;
      this.server.process().stderr?.on('data', chunk => {
        if (diagnosticBytes >= 16384) return;
        const bounded = chunk.subarray(0, 16384 - diagnosticBytes); diagnosticBytes += bounded.length;
        process.stderr.write(bounded);
      });
      this.browser = await chromium.connect(this.server.wsEndpoint());
      this.browser.on('disconnected', () => { if (!this.closed) this.onFault('Native browser disconnected', true); });
    }
    const commandSession = await this.browser.newBrowserCDPSession();
    try {
      const { arguments: arguments_ } = await commandSession.send('Browser.getBrowserCommandLine');
      this.gpuProcessMode = arguments_.includes('--in-process-gpu') ? 'in-process' : 'separate';
    } finally { await commandSession.detach(); }
    const origin = new URL(url).origin, paths = new Set(allowedPaths);
    this.context = await this.browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block',
      ...(saved ? { storageState: saved.storageState } : {}) });
    await this.context.route('**/*', route => {
      const request = route.request(), address = new URL(request.url());
      const allowed = site ? allowedSiteRequest(site, request.url(), { navigation: request.isNavigationRequest(), method: request.method() })
        : address.origin === origin && paths.has(address.pathname) && request.method() === 'GET';
      return allowed
        ? route.continue() : route.abort('blockedbyclient');
    });
    this.page = await this.context.newPage();
    this.page.on('crash', () => { if (!this.closed) this.onFault('Native renderer crashed; session stopped', true); });
    this.context.on('page', page => { if (page !== this.page) page.close().catch(() => {}); });
    this.cdp = await this.context.newCDPSession(this.page);
    await this.onPage?.(this.page, this.cdp);
    this.traceActive = true;
    let trace;
    try {
      const capture = () => recordTrace(this.cdp, async () => {
        const response = await this.page.goto(url, { waitUntil: site ? 'domcontentloaded' : 'load', timeout: 15000 });
        this.url = this.page.url();
        ensure(response?.ok() && (site ? allowedSiteRequest(site, this.url, { navigation: true }) : this.url === url),
          502, 'NATIVE_NAVIGATION_FAILED', 'Native page did not load within its configured site policy');
        if (site) await this.page.waitForTimeout(750); else await settlePage(this.page);
      }, { traceConfig: STARTUP_TRACE });
      trace = await (this.sharedHost ? this.sharedHost.trace(capture) : capture());
    } finally { this.traceActive = false; }
    ensure(trace.dataLossOccurred === false, 502, 'NATIVE_PROVENANCE_INCOMPLETE', 'Startup process metadata was incomplete');
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    this.startupProvenance = findPageProvenance(trace.events, this.url);
    const provenance = site ? nativePageRoute(trace.events, this.url, frameTree.frame.id) : this.startupProvenance;
    this.startupProvenance = provenance;
    ensure(provenance.rendererPids.length === 1, 502, 'NATIVE_PROVENANCE_MISSING', 'Expected one renderer for the exact trusted page URL');
    this.provenance = { ...provenance, scope: 'One short metadata-only startup trace; frame delivery uses the authenticated native socket.' };
    this.rendererPid = provenance.rendererPids[0];
    this.retiredStartupTrees = new Set(provenance.retiredTreeIds || []);
    // Local fixtures force a draw. Public pages bind the proven destination
    // widget without resizing through a possibly retired about:blank widget.
    if (!site) {
      await this.page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
      await settlePage(this.page);
      await this.page.setViewportSize(viewport); await settlePage(this.page);
    }
    const deadline = Date.now() + 5000;
    while (!this.latest && Date.now() < deadline) {
      const candidates = [...this.candidates.values()].filter(message => message.pid === this.rendererPid &&
        (!provenance.route || message.snapshot?.tree_id === provenance.route.treeId) &&
        message.snapshot?.viewport?.[2] === viewport.width && message.snapshot?.viewport?.[3] === viewport.height)
        .sort((a, b) => a.ts - b.ts);
      const current = candidates.at(-1);
      const error = [...this.candidates.values()].filter(message => message.pid === this.rendererPid && message.error)
        .sort((a, b) => b.ts - a.ts)[0];
      if (error && (!current || error.ts >= current.ts)) { this.lastFault = error.error; break; }
      if (current) {
        this.route = { pid: current.pid, treeId: current.snapshot.tree_id };
        this.sharedHost?.router.bind(this.leaseId, this.route);
        this.accept(current);
      }
      if (!this.latest) await delay(20);
    }
    ensure(this.latest, this.lastFault ? 422 : 504, this.lastFault ? 'NATIVE_FRAME_UNSUPPORTED' : 'NATIVE_FRAME_TIMEOUT',
      this.lastFault || 'Native producer did not deliver a supported complete frame');
    this.candidates.clear();
    if (site) await settlePage(this.page);
    this.page.on('framenavigated', frame => {
      if (frame === this.page.mainFrame() && frame.url() !== this.url) this.onFault('Navigation outside the bound native page is unsupported');
    });
    return { runtime: 'chromium-native', browserPid: this.browserPid, rendererPid: this.rendererPid,
      nativeFrameId: this.latest.frame.id, stream: this.stream.stats, provenance: this.provenance };
  }
  receive(message) {
    if (this.closed) return;
    if (!this.route) {
      const key = `${message.pid}:${message.snapshot?.tree_id}`;
      if (!this.candidates.has(key) && this.candidates.size >= 4) this.candidates.delete(this.candidates.keys().next().value);
      this.candidates.set(key, message); return;
    }
    if (message.pid !== this.route.pid) { this.excluded++; return; }
    if (message.snapshot && message.snapshot.tree_id !== this.route.treeId) {
      if (this.retiredStartupTrees?.has(message.snapshot.tree_id)) { this.excluded++; return; }
      this.onFault('Additional native widget in this renderer is unsupported'); return;
    }
    this.accept(message);
  }
  accept(message) {
    try {
      ensure(!message.error, 422, 'NATIVE_FRAME_UNSUPPORTED', message.error || 'Native producer error');
      const native = { name: 'VirtualDesktop.RemotePaintFrame', cat: 'cc', pid: message.pid, ts: message.ts,
        args: { snapshot: message.snapshot } };
      const { frame, bytes } = normalizeNativeFrame(native);
      ensure(frame.viewport.width === this.viewport.width && frame.viewport.height === this.viewport.height,
        422, 'NATIVE_VIEWPORT_UNSUPPORTED', 'Native viewport changed outside the session configuration');
      this.frames++;
      this.latest = { frame, signature: visualSignature(frame) };
      this.onFrame({ frame, resources: [...bytes].map(([id, data]) => ({ id, data })) });
    } catch (error) { this.latest = null; this.lastFault = error.message; this.onFault(error.message); }
  }
  async action({ actionId, action, expectedSignature }) {
    const signature = JSON.stringify(action), existing = this.actions.get(actionId);
    if (existing) {
      ensure(existing.signature === signature, 409, 'ACTION_ID_REUSED', 'Action id already used with a different payload');
      return { ...existing.result, deduplicated: true };
    }
    const before = this.frames;
    if (['pointer', 'wheel'].includes(action.type)) {
      ensure(this.latest && expectedSignature === this.latest.signature, 409, 'STALE_FRAME', 'Native page changed before input dispatch');
    }
    await browserAction(this.page, this.viewport, action);
    await settlePage(this.page);
    const deadline = Date.now() + 250;
    while (this.frames === before && Date.now() < deadline) await delay(10);
    const result = { actionId, deduplicated: false, nativeFrameId: this.latest?.frame.id ?? null,
      nativeFrames: this.frames, unchanged: this.frames === before };
    this.actions.set(actionId, { signature, result });
    if (this.actions.size > 1000) this.actions.delete(this.actions.keys().next().value);
    return result;
  }
  async dispatch(method, params = {}) {
    if (method === 'diagnostics') {
      ensure(!this.sharedHost, 409, 'SHARED_TRACE_RESTRICTED', 'Per-session diagnostics cannot start a browser-wide trace on a shared host');
      if (params.type === 'start') {
        ensure(!this.traceActive, 409, 'TRACE_BUSY', 'A diagnostic trace is already active');
        this.traceActive = true;
        let started, failed;
        const ready = new Promise((resolve, reject) => { started = resolve; failed = reject; });
        const stop = new Promise(resolve => { this.stopTrace = resolve; });
        this.diagnosticTrace = recordTrace(this.cdp, async () => { started(); await stop; });
        this.diagnosticTrace.catch(error => { this.traceActive = false; this.stopTrace = null; failed(error); });
        await ready;
        return { started: true };
      }
      ensure(params.type === 'stop' && this.traceActive && this.stopTrace, 409, 'TRACE_NOT_RUNNING', 'No diagnostic trace is active');
      this.stopTrace();
      try { return await this.diagnosticTrace; }
      finally { this.traceActive = false; this.stopTrace = null; }
    }
    if (method === 'action') return this.action(params);
    if (method === 'observe') return this.page.evaluate(() => ({ title: document.title, url: location.href,
      text: document.body.innerText.slice(0, 32768), targets: [...document.querySelectorAll('input[id],button[id],textarea[id],select[id]')].slice(0, 200)
        .map(element => ({ selector: '#' + CSS.escape(element.id), role: element.tagName.toLowerCase(),
          name: element.getAttribute('aria-label') || element.textContent.slice(0, 160), value: element.value?.slice(0, 2000), disabled: element.disabled })) }));
    if (method === 'metrics') return { runtime: 'chromium-native', pid: process.pid, browserPid: this.browserPid,
      rendererPid: this.rendererPid, gpuProcessMode: this.gpuProcessMode, nativeFrames: this.frames, excludedProducers: this.excluded,
      nativeFrameId: this.latest?.frame.id ?? null, stream: this.stream.stats, traceActive: this.traceActive,
      memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
      scope: 'Worker memory only; excludes Chromium browser/renderer process memory', engineSplitGate: 'not-passed' };
    if (method === 'save') return { kind: 'chromium-storage-v1', storageState: await this.context.storageState(),
      scope: 'Cookies and localStorage only; JS heap, DOM and sessionStorage are not a cold snapshot.' };
    ensure(false, 400, 'UNSUPPORTED_METHOD', 'Unsupported native worker method');
  }
  async close() {
    this.closed = true;
    if (this.sharedHost) {
      this.sharedHost.router.detach(this.leaseId);
      await this.context?.close().catch(() => {}); this.candidates.clear(); this.latest = null; return;
    }
    await this.server?.close().catch(() => {});
    await this.stream?.close();
  }
}
