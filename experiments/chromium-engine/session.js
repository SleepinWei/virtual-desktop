import { chromium } from 'playwright';
import { verifiedEngine } from './verified.js';
import { createNativeStream } from './native-stream.js';
import { captureLaunchArgs, findPageProvenance, recordTrace, settlePage } from '../chromium-paint/capture.js';
import { normalizeNativeFrame } from '../chromium-paint/native-frame.js';
import { visualSignature } from '../../src/native-frames.js';
import { ensure } from '../../src/errors.js';

const STARTUP_TRACE = { recordMode: 'recordAsMuchAsPossible', traceBufferSizeInKb: 4096,
  includedCategories: ['disabled-by-default-devtools.timeline'], excludedCategories: ['*'] };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class ChromiumSession {
  constructor({ onFrame, onFault, onBrowser }) {
    this.onFrame = onFrame; this.onFault = onFault; this.onBrowser = onBrowser;
    this.candidates = new Map(); this.actions = new Map(); this.frames = 0; this.excluded = 0;
    this.latest = null; this.route = null; this.closed = false; this.traceActive = false;
  }
  async start({ root, expectedArtifactsSha256, expectedPatchSha256, url, viewport, saved, allowedPaths }) {
    const verified = await verifiedEngine(root, { requireStream: true });
    ensure(verified.artifactsSha256 === expectedArtifactsSha256 && verified.patchSha256 === expectedPatchSha256,
      409, 'ENGINE_CHANGED', 'Native build changed; restart the service before creating sessions');
    this.viewport = viewport; this.url = url;
    if (saved) ensure(saved.kind === 'chromium-storage-v1' && saved.storageState && Array.isArray(saved.storageState.cookies) &&
      Array.isArray(saved.storageState.origins), 409, 'INVALID_PROFILE_STATE', 'Expected a Chromium storage profile');
    this.stream = await createNativeStream(message => this.receive(message));
    this.server = await chromium.launchServer({ executablePath: verified.binary, headless: true, host: '127.0.0.1',
      chromiumSandbox: false, args: captureLaunchArgs({ remotePaint: true, noDisplay: true, producerBufferBytes: 33554432 }),
      env: { ...process.env, ...this.stream.environment } });
    this.browserPid = this.server.process().pid; this.onBrowser(this.browserPid, this.server.process());
    this.browser = await chromium.connect(this.server.wsEndpoint());
    this.browser.on('disconnected', () => { if (!this.closed) this.onFault('Native browser disconnected', true); });
    const origin = new URL(url).origin, paths = new Set(allowedPaths);
    this.context = await this.browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: false,
      ...(saved ? { storageState: saved.storageState } : {}) });
    await this.context.route('**/*', route => {
      const request = new URL(route.request().url());
      return request.origin === origin && paths.has(request.pathname) && route.request().method() === 'GET'
        ? route.continue() : route.abort('blockedbyclient');
    });
    this.page = await this.context.newPage();
    this.context.on('page', page => { if (page !== this.page) page.close().catch(() => {}); });
    this.cdp = await this.context.newCDPSession(this.page);
    this.traceActive = true;
    let trace;
    try {
      trace = await recordTrace(this.cdp, async () => {
        const response = await this.page.goto(url, { waitUntil: 'load', timeout: 15000 });
        ensure(response?.ok() && this.page.url() === url, 502, 'NATIVE_NAVIGATION_FAILED', 'Trusted native fixture did not load');
        await settlePage(this.page);
      }, { traceConfig: STARTUP_TRACE });
    } finally { this.traceActive = false; }
    ensure(trace.dataLossOccurred === false, 502, 'NATIVE_PROVENANCE_INCOMPLETE', 'Startup process metadata was incomplete');
    const provenance = findPageProvenance(trace.events, url);
    ensure(provenance.rendererPids.length === 1, 502, 'NATIVE_PROVENANCE_MISSING', 'Expected one renderer for the exact trusted page URL');
    this.provenance = { ...provenance, scope: 'One short metadata-only startup trace; frame delivery uses the authenticated native socket.' };
    this.rendererPid = provenance.rendererPids[0];
    // Force an initial complete draw after fonts load, even with no viewer.
    await this.page.setViewportSize({ width: viewport.width + 1, height: viewport.height });
    await settlePage(this.page);
    await this.page.setViewportSize(viewport); await settlePage(this.page);
    const deadline = Date.now() + 5000;
    while (!this.latest && Date.now() < deadline) {
      const candidates = [...this.candidates.values()].filter(message => message.pid === this.rendererPid &&
        message.snapshot?.viewport?.[2] === viewport.width && message.snapshot?.viewport?.[3] === viewport.height)
        .sort((a, b) => a.ts - b.ts);
      const current = candidates.at(-1);
      if (current) {
        this.route = { pid: current.pid, treeId: current.snapshot.tree_id };
        this.accept(current);
      }
      if (!this.latest) await delay(20);
    }
    ensure(this.latest, 504, 'NATIVE_FRAME_TIMEOUT', 'Native producer did not deliver a supported complete frame');
    this.candidates.clear();
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
    } catch (error) { this.latest = null; this.onFault(error.message); }
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
    if (action.type === 'click' || action.type === 'fill') {
      ensure(typeof action.selector === 'string' && action.selector.length <= 200, 400, 'INVALID_SELECTOR', 'A short CSS selector is required');
      if (action.type === 'fill') {
        ensure(typeof action.value === 'string' && action.value.length <= 2000, 400, 'INVALID_VALUE', 'Input is limited to 2000 characters');
        await this.page.locator(action.selector).fill(action.value, { timeout: 3000 });
      } else await this.page.locator(action.selector).click({ timeout: 3000 });
    } else if (action.type === 'pointer' || action.type === 'wheel') {
      ensure(Number.isFinite(action.x) && Number.isFinite(action.y) && action.x >= 0 && action.y >= 0 &&
        action.x < this.viewport.width && action.y < this.viewport.height, 400, 'INVALID_COORDINATES', 'Input must lie within the native viewport');
      if (action.type === 'pointer') await this.page.mouse.click(action.x, action.y);
      else {
        ensure(Number.isFinite(action.deltaY) && Math.abs(action.deltaY) <= 2000 &&
          Number.isFinite(action.deltaX ?? 0) && Math.abs(action.deltaX ?? 0) <= 2000, 400, 'INVALID_WHEEL', 'Wheel delta exceeds the local limit');
        await this.page.mouse.move(action.x, action.y); await this.page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
      }
    } else if (action.type === 'text') {
      ensure(typeof action.value === 'string' && action.value.length <= 2000, 400, 'INVALID_VALUE', 'Text is limited to 2000 characters');
      await this.page.keyboard.insertText(action.value);
    } else if (action.type === 'key') {
      ensure(['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(action.key),
        400, 'INVALID_KEY', 'Unsupported native key');
      await this.page.keyboard.press(action.key);
    } else ensure(false, 400, 'UNSUPPORTED_ACTION', 'Unsupported native action');
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
      rendererPid: this.rendererPid, nativeFrames: this.frames, excludedProducers: this.excluded,
      nativeFrameId: this.latest?.frame.id ?? null, stream: this.stream.stats, traceActive: this.traceActive,
      memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
      scope: 'Worker memory only; excludes Chromium browser/renderer process memory', engineSplitGate: 'not-passed' };
    if (method === 'save') return { kind: 'chromium-storage-v1', storageState: await this.context.storageState(),
      scope: 'Cookies and localStorage only; JS heap, DOM and sessionStorage are not a cold snapshot.' };
    ensure(false, 400, 'UNSUPPORTED_METHOD', 'Unsupported native worker method');
  }
  async close() {
    this.closed = true;
    await this.server?.close().catch(() => {});
    await this.stream?.close();
  }
}
