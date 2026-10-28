import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createService } from '../../src/server.js';
import { AgentClient } from '../../src/client.js';
import { verifiedEngine } from './verified.js';
import { nativeFixtures } from './assets.js';
import { analyzeEngineEvidence } from './evidence.js';
import { decoded, crop, comparePixels } from '../chromium-paint/verify.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function until(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(40); }
  throw new Error('Timed out: ' + message);
}
const png = async page => Buffer.from((await page.locator('#desktop').evaluate(canvas => canvas.toDataURL('image/png'))).split(',')[1], 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// All PNG generation is in the independent LOCAL viewer/reference browser.
// The execution worker delivers native records through its authenticated socket.
export async function verifyLive({ root, canvasKitDirectory, outputDir, executablePath }) {
  await mkdir(outputDir, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'vd-live-verify-'));
  const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', steps: [],
    visuals: [], errors: [], engineSplitGate: 'not-passed', serverRasterBypassed: false };
  const save = () => writeFile(join(outputDir, 'live-report.json'), JSON.stringify(report, null, 2));
  await save();
  let service, browser;
  try {
    const engine = await verifiedEngine(root, { requireStream: true });
    report.build = { revision: engine.source.revision, skiaRevision: engine.source.skiaRevision,
      patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256, artifacts: engine.state.artifacts };
    service = createService({ dataDir, adminToken: 'test-admin', maxActive: 2,
      chromium: { root, canvasKitDirectory, maxSessions: 2 } });
    const base = await service.listen(0);
    report.replayRuntime = await (await fetch(base + '/native-runtime/runtime.json')).json();
    report.fixtureSha256 = {};
    for (const [path, asset] of nativeFixtures) {
      if (!path.startsWith('/live-fixture.') && !path.startsWith('/fonts/')) continue;
      const source = await readFile(asset.file), served = Buffer.from(await (await fetch(base + path)).arrayBuffer());
      check(digest(source) === digest(served), 'Served native fixture differs: ' + path);
      report.fixtureSha256[path] = digest(source);
    }
    async function api(path, token = 'test-admin', payload) {
      const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', headers: {
        Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
      return { status: response.status, data: await response.json() };
    }
    const created = await api('/api/sessions', 'test-admin', { backend: 'chromium' });
    check(created.status === 201, 'Native session creation failed: ' + JSON.stringify(created.data));
    const session = created.data, path = operation => `/api/sessions/${session.id}/${operation}`;
    const agent = new AgentClient(base, session), internal = service.manager.get(session.id);
    const metrics = async () => (await api(path('metrics'))).data;
    const observe = async () => (await api(path('observe'), session.viewerToken)).data;
    const state = async () => {
      const observation = await observe();
      return { count: Number(/Increment\s+(\d+)/.exec(observation.text)?.[1]),
        tick: Number(/Page timer\s+(\d+)/.exec(observation.text)?.[1]),
        value: observation.targets.find(target => target.selector === '#message')?.value, observation };
    };
    await agent.fill('#message', 'Agent before viewer'); await agent.click('#increment');
    report.withoutViewer = { metrics: await metrics(), state: await state() };
    check(report.withoutViewer.state.count === 1 && report.withoutViewer.state.value === 'Agent before viewer', 'Agent cannot operate without a viewer');
    check(report.withoutViewer.metrics.traceActive === false && report.withoutViewer.metrics.frames.connections.length === 0, 'Frame delivery depends on an attached viewer or active trace');
    report.steps.push('Agent executes in a persistent Chromium page before any viewer connects');

    browser = await chromium.launch({ executablePath: executablePath || engine.binary, headless: true });
    report.localValidationBrowser = browser.version();
    const context = await browser.newContext({ viewport: { width: 1180, height: 1100 }, deviceScaleFactor: 1 });
    await context.addInitScript(value => sessionStorage.setItem('vd-native-viewer', JSON.stringify(value)), session);
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(base + '/native'); await page.locator('#admin-token').fill('test-admin');
    const ready = () => page.waitForFunction(() => document.documentElement.dataset.connection === 'connected' &&
      Boolean(window.nativeViewer?.state().client?.presented), undefined, { timeout: 15000 });
    await ready();
    const refContext = await browser.newContext({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    const reference = await refContext.newPage();
    await reference.goto(base + '/live-fixture.html'); await reference.evaluate(() => document.fonts.ready);
    await reference.locator('#message').fill('Agent before viewer'); await reference.locator('#increment').click();
    async function compare(name) {
      await ready();
      const clientBytes = await png(page), referenceBytes = await reference.screenshot({ path: join(outputDir, `reference-${name}.png`) });
      await writeFile(join(outputDir, `client-${name}.png`), clientBytes);
      const actual = await decoded(clientBytes), expected = await decoded(referenceBytes), regions = [];
      for (const selector of ['header', '#increment', '#count', '#message', '#echo', '#pulse', '#scroller']) {
        const bounds = await reference.locator(selector).boundingBox();
        check(bounds, 'Missing reference region ' + selector);
        regions.push({ selector, bounds, ...comparePixels(crop(expected, bounds), crop(actual, bounds)) });
      }
      const whole = comparePixels(expected, actual), passed = whole.passed && regions.every(region => region.passed);
      report.visuals.push({ name, passed, whole, regions }); await save();
      check(passed, 'Strict live visual comparison failed: ' + name);
    }
    await compare('agent-before-viewer');
    const initialPresented = await page.evaluate(() => window.nativeViewer.state().client.presented);
    await page.locator('#take').click();
    await page.waitForFunction(() => window.nativeViewer.state().control.owner === 'human');
    check((await api(path('actions'), session.agentToken, { epoch: 1, actionId: 'stale-agent', action: { type: 'click', selector: '#increment' } })).data.error?.code === 'CONTROL_LOST', 'Old agent retained control');
    check((await api(path('actions'), session.viewerToken, { epoch: 2, actionId: 'read-only', action: { type: 'click', selector: '#increment' } })).data.error?.code === 'READ_ONLY', 'Viewer can mutate page state');
    async function point(x, y) {
      await ready();
      const bounds = await page.locator('#desktop').boundingBox();
      await page.locator('#desktop').click({ position: { x: x * bounds.width / 960, y: y * bounds.height / 720 } });
    }
    await point(80, 140);
    await until(async () => (await state()).count === 2, 'Human coordinate click');
    await reference.locator('#increment').click();
    const stale = await api(path('actions'), session.humanToken, { epoch: 2, actionId: 'stale-pixels',
      action: { type: 'pointer', x: 80, y: 140, ...initialPresented } });
    check(stale.data.error?.code === 'STALE_FRAME', 'Stale displayed frame accepted coordinate input');
    report.steps.push('Human takeover rejects the old agent, read-only mutation and stale displayed coordinates');
    await point(520, 250); await delay(120); await ready();
    await page.locator('#text').fill(' + human'); await page.locator('#send').click();
    await until(async () => (await state()).value === 'Agent before viewer + human', 'Native text insertion');
    await reference.locator('#message').click({ position: { x: 500, y: 24 } }); await reference.keyboard.insertText(' + human');
    const bounds = await page.locator('#desktop').boundingBox();
    await page.mouse.move(bounds.x + 800 * bounds.width / 960, bounds.y + 400 * bounds.height / 720); await page.mouse.wheel(0, 180);
    await until(() => internal.frames.latest?.frame.scrollOffsets.some(item => item.offset[1] === 180), 'Native wheel scroll');
    await reference.mouse.move(800, 400); await reference.mouse.wheel(0, 180);
    await reference.waitForFunction(() => document.querySelector('#scroller').scrollTop === 180);
    await delay(160); await compare('human-input-scroll');
    report.steps.push('Human coordinate focus, native text insertion and wheel scrolling reach the real page and local pixels');

    const beforeTimer = await metrics(), beforeTimerImage = digest(await png(page));
    await page.locator('[data-key="Tab"]').click(); await delay(100); await page.locator('[data-key="Enter"]').click();
    await until(async () => (await state()).tick >= 3, 'Autonomous timer progression');
    await ready();
    const afterTimer = await metrics(), afterTimerImage = digest(await png(page));
    report.autonomous = { before: beforeTimer, after: afterTimer, pixelsChanged: beforeTimerImage !== afterTimerImage };
    check(!afterTimer.traceActive && afterTimer.nativeFrames > beforeTimer.nativeFrames + 2 &&
      afterTimer.frames.revision > beforeTimer.frames.revision + 2 && report.autonomous.pixelsChanged, 'Autonomous page updates do not stream without trace/action capture');
    report.steps.push('Native Tab/Enter starts page-owned timers; multiple new frames and pixels arrive while trace is stopped');

    const oldEpoch = (await page.evaluate(() => window.nativeViewer.state())).client.epoch, beforeOffline = await state();
    await context.setOffline(true); await delay(900);
    const duringOffline = await state();
    check(duringOffline.tick > beforeOffline.tick && (await metrics()).browserPid === beforeTimer.browserPid, 'Viewer disconnection stopped/restarted the browser');
    await context.setOffline(false); await page.locator('#reconnect').click(); await ready();
    const afterReconnect = await page.evaluate(() => window.nativeViewer.state());
    check(afterReconnect.client.epoch !== oldEpoch && afterReconnect.sessionId === session.id, 'Reconnect did not establish a fresh full-frame epoch');
    await page.reload(); await ready();
    check((await page.evaluate(() => window.nativeViewer.state())).sessionId === session.id && (await metrics()).browserPid === beforeTimer.browserPid,
      'Viewer reload failed to restore the same running page');
    report.reconnect = { browserPid: beforeTimer.browserPid, oldEpoch, newEpoch: afterReconnect.client.epoch,
      beforeOffline: { count: beforeOffline.count, tick: beforeOffline.tick }, duringOffline: { count: duringOffline.count, tick: duringOffline.tick },
      afterReload: await page.evaluate(() => window.nativeViewer.state()) };
    report.steps.push('Offline viewer and full viewer reload restore fresh epochs while the same browser/page keeps advancing');

    await api(path('actions'), session.humanToken, { epoch: 2, actionId: 'stop-timer', action: { type: 'click', selector: '#animate' } });
    await ready();
    // Force a real new resource response to be corrupt once. Reconnection must
    // fetch a fresh full snapshot and return to a healthy stream without ACKing
    // the corrupt payload or resetting the page.
    let corrupted = false;
    await page.route('**/frames/resources/*', async route => {
      if (corrupted) return route.continue();
      const response = await route.fetch(), bytes = await response.body(); bytes[0] ^= 1; corrupted = true;
      await route.fulfill({ response, body: bytes });
    });
    await api(path('actions'), session.humanToken, { epoch: 2, actionId: 'resource-retry', action: { type: 'fill', selector: '#message', value: 'Recovered native resource' } });
    await until(() => corrupted, 'Corrupt resource injection'); await delay(450); await ready();
    report.resourceRecovery = { corrupted, sameBrowser: (await metrics()).browserPid === beforeTimer.browserPid,
      value: (await state()).value, client: await page.evaluate(() => window.nativeViewer.state().client) };
    check(report.resourceRecovery.sameBrowser && report.resourceRecovery.value === 'Recovered native resource', 'Resource failure lost the running page');
    await page.unroute('**/frames/resources/*');
    report.steps.push('A corrupt resource triggers a fresh snapshot/retry while preserving the same execution session');

    const secondaryResult = await api('/api/sessions', 'test-admin', { backend: 'chromium' });
    check(secondaryResult.status === 201, 'Second native session could not start');
    const secondary = secondaryResult.data, secondaryAgent = new AgentClient(base, secondary);
    const secondaryPath = operation => `/api/sessions/${secondary.id}/${operation}`;
    const secondaryMetrics = (await api(secondaryPath('metrics'))).data;
    check(secondaryMetrics.browserPid !== beforeTimer.browserPid && /Increment\s+0/.test((await secondaryAgent.observe()).text), 'Native sessions shared execution or storage');
    check((await api(secondaryPath('observe'), session.viewerToken)).status === 403, 'A capability crossed native sessions');
    await secondaryAgent.fill('#message', 'Ephemeral DOM'); await secondaryAgent.click('#increment');
    check((await api(secondaryPath('release'), 'test-admin', { save: true })).status === 200, 'Native profile save failed');
    const restoredResult = await api('/api/sessions', 'test-admin', { backend: 'chromium', profileId: secondary.profileId });
    check(restoredResult.status === 201, 'Native storage profile did not restore');
    const restored = restoredResult.data, restoredAgent = new AgentClient(base, restored), restoredObservation = await restoredAgent.observe();
    const restoredMetrics = (await api(`/api/sessions/${restored.id}/metrics`)).data;
    check(/Increment\s+1/.test(restoredObservation.text) && restoredObservation.targets.find(target => target.selector === '#message')?.value === '' &&
      restoredMetrics.browserPid !== secondaryMetrics.browserPid, 'Native cold restore did not preserve only the documented storage state');
    check((await state()).count === 2 && (await state()).value === 'Recovered native resource', 'Secondary native session changed the first page');
    report.nativeIsolationAndStorage = { independentBrowsers: true, crossSessionCredentialRejected: true,
      originalBrowserPid: secondaryMetrics.browserPid, restoredBrowserPid: restoredMetrics.browserPid,
      persistedCount: 1, ephemeralInputCleared: true, scope: 'Cookies/localStorage profile in a new browser; no JS heap or DOM snapshot.' };
    check((await api(`/api/sessions/${restored.id}/release`, 'test-admin', { save: false })).status === 200, 'Restored browser did not stop');
    report.steps.push('Two native sessions keep separate state/capabilities; cold restore persists localStorage in a new browser and clears transient DOM');

    await internal.worker.call('diagnostics', { type: 'start' });
    await page.locator('#return').click(); await page.waitForFunction(() => window.nativeViewer.state().control.owner === 'agent');
    check((await api(path('actions'), session.humanToken, { epoch: 2, actionId: 'old-human', action: { type: 'click', selector: '#increment' } })).data.error?.code === 'CONTROL_LOST', 'Old human epoch remained valid');
    await agent.observe(); await agent.click('#increment'); await agent.click('#increment');
    const once = await agent.action({ type: 'click', selector: '#increment' }, 'live-dedup');
    const again = await agent.action({ type: 'click', selector: '#increment' }, 'live-dedup');
    check(!once.deduplicated && again.deduplicated && (await state()).count === 5, 'Native action retry changed the page twice');
    const trace = await internal.worker.call('diagnostics', { type: 'stop' });
    await writeFile(join(outputDir, 'live-trace.json'), JSON.stringify({ traceEvents: trace.events, dataLossOccurred: trace.dataLossOccurred }));
    report.engine = analyzeEngineEvidence({ traceEvents: trace.events }, { rendererPids: [beforeTimer.rendererPid], traceComplete: trace.dataLossOccurred === false });
    check(report.engine.recordOnlyDisplayCandidate, 'Live native pixel-path evidence failed');
    const afterTrace = await metrics(); await agent.click('#increment');
    const afterTraceAction = await metrics();
    check(!afterTraceAction.traceActive && afterTraceAction.nativeFrames > afterTrace.nativeFrames, 'Direct frame delivery stopped when diagnostic trace ended');
    report.steps.push('Live diagnostic trace preserves the candidate zero-raster/zero-renderer-draw evidence; updates continue after trace ends');
    await page.screenshot({ path: join(outputDir, 'live-viewer.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Native viewer overflows on a narrow viewport');
    await page.screenshot({ path: join(outputDir, 'live-viewer-narrow.png'), fullPage: true });

    const owned = { workerPid: afterTraceAction.pid, browserPid: afterTraceAction.browserPid, rendererPid: afterTraceAction.rendererPid };
    internal.worker.child.kill('SIGKILL'); await internal.worker.exited;
    await until(() => {
      for (const pid of [owned.browserPid, owned.rendererPid]) {
        try { process.kill(pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      return true;
    }, 'Owned Chromium process cleanup', 5000);
    report.crashCleanup = { ...owned, sessionState: internal.state, activeSlots: service.manager.stats().active, processesGone: true };
    check(internal.state === 'FAILED' && service.manager.stats().active === 0, 'Worker crash retained a session slot');
    report.steps.push('Killing the execution worker reaps its browser/renderer group and frees session capacity');
    report.status = report.errors.length ? 'acceptance-not-met' : 'live-native-session-candidate';
    report.limitations = ['Trusted fixed A8 fixtures, one bound main renderer/widget; arbitrary websites, iframe, IME/DPR and image/media paths remain unverified.',
      'Chromium runs without its sandbox in this local experiment; no production multi-tenant isolation claim.',
      'A short metadata-only startup trace binds renderer provenance; live frames do not use trace transport.',
      'Process memory in worker metrics excludes Chromium processes. No total CPU/RSS/bandwidth or production runtime-size claim.'];
  } catch (error) { report.errors.push(error.message); report.status = 'failed'; }
  finally {
    if (browser) await browser.close().catch(error => report.errors.push(error.message));
    if (service) await service.close().catch(error => report.errors.push(error.message));
    await rm(dataDir, { recursive: true, force: true });
    if (report.errors.length && report.status === 'live-native-session-candidate') report.status = 'acceptance-not-met';
    report.finishedAt = new Date().toISOString(); await save();
  }
  return report;
}
