import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createService } from '../../src/server.js';
import { verifiedEngine } from './verified.js';
import { startLoadGuard } from './load-guard.js';
import { allowedSiteRequest, externalSites } from './sites.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, output: { type: 'string', default: 'test-results/chromium-xiaohongshu' },
  site: { type: 'string', default: 'xiaohongshu' }, viewer: { type: 'boolean', default: false } } });
if (!Object.hasOwn(externalSites, values.site)) throw new Error('Choose a configured external site');
const output = resolve(values.output); await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), site: values.site, url: externalSites[values.site].url,
  status: 'initializing', errors: [], engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'Fresh unauthenticated public page. No login, CAPTCHA bypass or compatibility claim from navigation alone.' };
let guard, service, browserServer, temporary;
try {
  guard = await startLoadGuard();
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256 };
  temporary = await mkdtemp(join(tmpdir(), 'vd-site-probe-'));
  service = createService({ dataDir: temporary, adminToken: 'probe-local', maxActive: 1,
    onWorker: worker => guard.add(worker.child.pid), chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: 1, externalSites: true } });
  const base = await service.listen(0);
  const response = await fetch(base + '/api/sessions', { method: 'POST', signal: AbortSignal.timeout(35000),
    headers: { Authorization: 'Bearer probe-local', 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: 'chromium', fixture: values.site }) });
  const native = await response.json(); report.native = { status: response.status, error: native.error || null,
    sessionStates: [...service.manager.sessions.values()].map(session => ({ state: session.state, frames: session.frames?.stats,
      workerDiagnostics: session.worker?.diagnostics })) };
  guard.check();
  const release = () => fetch(`${base}/api/sessions/${native.id}/release`, { method: 'POST', headers: { Authorization: 'Bearer probe-local', 'Content-Type': 'application/json' }, body: '{"save":false}' });
  if (response.ok && !values.viewer) { await release(); report.native.viewerSkipped = 'Avoid a second active browser under the host RSS budget; export is not a replay/visual pass.'; }
  browserServer = await chromium.launchServer({ executablePath: engine.binary, headless: true, chromiumSandbox: false });
  guard.add(browserServer.process().pid);
  let diagnosticBytes = 0; report.ordinaryDiagnostics = '';
  browserServer.process().stderr?.on('data', chunk => {
    if (diagnosticBytes >= 16384) return;
    const bounded = chunk.subarray(0, 16384 - diagnosticBytes); diagnosticBytes += bounded.length; report.ordinaryDiagnostics += bounded.toString();
  });
  const browser = await chromium.connect(browserServer.wsEndpoint());
  if (response.ok && values.viewer) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 1100 } });
    await context.addInitScript(session => sessionStorage.setItem('vd-native-viewer', JSON.stringify(session)), native);
    const viewer = await context.newPage(); await viewer.goto(base + '/native');
    try {
      await viewer.waitForFunction(() => document.documentElement.dataset.connection === 'connected', undefined, { timeout: 15000 });
      await viewer.waitForTimeout(1500);
      report.native.viewer = await viewer.evaluate(() => ({ status: document.documentElement.dataset.connection, state: window.nativeViewer.state(),
        message: document.querySelector('#connection').textContent }));
      await viewer.screenshot({ path: join(output, 'native-viewer.png'), fullPage: true });
    } catch (error) { report.native.presentationError = error.message; }
    await release();
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 960, height: 720 }, serviceWorkers: 'block' });
  await context.route('**/*', route => allowedSiteRequest(values.site, route.request().url(), { navigation: route.request().isNavigationRequest(), method: route.request().method() }) ? route.continue() : route.abort());
  const reference = await context.newPage();
  const ordinaryResponse = await reference.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await reference.waitForTimeout(1000); guard.check();
  report.ordinary = { httpStatus: ordinaryResponse?.status(), url: reference.url(), title: await reference.title(),
    text: (await reference.locator('body').innerText()).slice(0, 1500) };
  await reference.screenshot({ path: join(output, 'ordinary-public-page.png'), timeout: 5000 });
  report.status = report.native.viewer?.status === 'connected' ? 'public-page-preview-only'
    : response.ok && !values.viewer ? 'native-frame-export-only' : 'native-site-not-supported';
} catch (error) { report.errors.push(error.message); report.status = guard?.stopped ? 'safety-stopped' : 'probe-failed'; }
finally {
  await browserServer?.close().catch(() => {}); await service?.close().catch(() => {});
  if (guard) { report.safety = { stopped: guard.stopped, baseline: guard.baseline, samples: guard.samples }; await guard.close(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, native: report.native, ordinary: report.ordinary, errors: report.errors, output }, null, 2));
process.exitCode = ['public-page-preview-only', 'native-frame-export-only', 'native-site-not-supported'].includes(report.status) ? 0 : 1;
