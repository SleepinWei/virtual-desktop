import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createService } from '../../src/server.js';
import { verifiedEngine } from './verified.js';
import { startLoadGuard } from './load-guard.js';
import { allowedSiteRequest, externalSites } from './sites.js';
import { browserProcessArgs, imageAnimationArgs } from './browser-runtime.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, output: { type: 'string' },
  site: { type: 'string', default: 'xiaohongshu' }, viewer: { type: 'boolean', default: false },
  interact: { type: 'boolean', default: false },
  mode: { type: 'string', default: 'both' }, 'max-rss-mib': { type: 'string', default: '1536' } } });
if (!Object.hasOwn(externalSites, values.site)) throw new Error('Choose a configured external site');
if (!['both', 'native', 'ordinary'].includes(values.mode)) throw new Error('Choose --mode both, native or ordinary');
if (values.viewer && values.mode !== 'both') throw new Error('--viewer requires --mode both');
if (values.interact && (!values.viewer || values.site !== 'bilibili')) throw new Error('--interact requires the Bilibili live viewer');
const maxRssMiB = Number(values['max-rss-mib']);
if (maxRssMiB !== 1536 && !(values.viewer && values.mode === 'both' && maxRssMiB === 2048))
  throw new Error('Only an explicit combined live producer/viewer probe may use 2048 MiB; other site probes require 1536 MiB');
const output = resolve(values.output || `test-results/chromium-${values.site}`); await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), site: values.site, url: externalSites[values.site].url,
  mode: values.mode, maxRssMiB, imageAnimationPolicy: externalSites[values.site].imageAnimationPolicy ?? 'static-only', status: 'initializing', errors: [], engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'Fresh unauthenticated public page. No login, CAPTCHA bypass or compatibility claim from navigation alone.' };
let guard, service, browserServer, temporary;

async function referenceBrowser(engine) {
  browserServer = await chromium.launchServer({ executablePath: engine.binary, headless: true, chromiumSandbox: false,
    args: [...browserProcessArgs(), ...imageAnimationArgs(externalSites[values.site].imageAnimationPolicy)], timeout: 15000 });
  const pid = browserServer.process().pid;
  guard.add(pid); browserServer.process().once('exit', () => guard.remove(pid));
  let diagnosticBytes = 0; report.ordinaryDiagnostics = '';
  browserServer.process().stderr?.on('data', chunk => {
    if (diagnosticBytes >= 16384) return;
    const bounded = chunk.subarray(0, 16384 - diagnosticBytes); diagnosticBytes += bounded.length; report.ordinaryDiagnostics += bounded.toString();
  });
  return chromium.connect(browserServer.wsEndpoint());
}

async function ordinaryPage(browser) {
  report.phase = 'ordinary';
  const context = await browser.newContext({ viewport: { width: 960, height: 720 }, acceptDownloads: false, serviceWorkers: 'block' });
  const blocked = new Map(), requested = new Map();
  try {
    await context.route('**/*', route => {
      const request = route.request(), host = new URL(request.url()).hostname;
      requested.set(host, (requested.get(host) || 0) + 1);
      if (allowedSiteRequest(values.site, request.url(), { navigation: request.isNavigationRequest(), method: request.method() })) return route.continue();
      blocked.set(host, (blocked.get(host) || 0) + 1); return route.abort();
    });
    const page = await context.newPage();
    context.on('page', other => { if (other !== page) other.close().catch(() => {}); });
    const response = await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000); guard.check();
    report.ordinary = { httpStatus: response?.status(), url: page.url(), title: await page.title(),
      ...await page.evaluate(() => ({ text: document.body.innerText.slice(0, 1500),
        images: { total: document.images.length, loaded: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length },
        inputs: [...document.querySelectorAll('input')].slice(0, 12).map(input => ({ type: input.type, placeholder: input.placeholder })) })),
      requestedHosts: Object.fromEntries(requested), blockedHosts: Object.fromEntries(blocked) };
    // A conventional reference only; never feeds the native frame producer.
    await page.screenshot({ path: join(output, 'ordinary-public-page.png'), timeout: 5000 }); guard.check();
  } finally { await context.close().catch(() => {}); }
}

try {
  guard = await startLoadGuard({ maxTreeRssBytes: maxRssMiB * 1024 ** 2 });
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256 };
  if (values.mode === 'ordinary') {
    await ordinaryPage(await referenceBrowser(engine));
    report.status = 'ordinary-page-only';
  } else {
    report.phase = 'native';
    temporary = await mkdtemp(join(tmpdir(), 'vd-site-probe-'));
    service = createService({ dataDir: temporary, adminToken: 'probe-local', maxActive: 1,
      onWorker(worker) { guard.add(worker.child.pid); worker.exited.then(() => guard.remove(worker.child.pid)); },
      chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: 1, externalSites: true } });
    const base = await service.listen(0);
    const response = await fetch(base + '/api/sessions', { method: 'POST', signal: AbortSignal.timeout(35000),
      headers: { Authorization: 'Bearer probe-local', 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: 'chromium', fixture: values.site }) });
    const native = await response.json(); report.native = { status: response.status, error: native.error || null,
      sessionStates: [...service.manager.sessions.values()].map(session => ({ state: session.state, frames: session.frames?.stats,
        workerDiagnostics: session.worker?.diagnostics })) };
    guard.check();
    const release = () => fetch(`${base}/api/sessions/${native.id}/release`, { method: 'POST', headers: { Authorization: 'Bearer probe-local', 'Content-Type': 'application/json' }, body: '{"save":false}' });
    if (response.ok && !values.viewer) {
      await release(); report.native.viewerSkipped = 'Avoid a second active browser under the host RSS budget; export is not a replay/visual pass.';
    }
    if (values.mode === 'both') {
      const browser = await referenceBrowser(engine);
      if (response.ok && values.viewer) {
        report.phase = 'viewer';
        const context = await browser.newContext({ viewport: { width: 1180, height: 1100 } });
        try {
          await context.addInitScript(session => sessionStorage.setItem('vd-native-viewer', JSON.stringify(session)), native);
          const viewer = await context.newPage(); await viewer.goto(base + '/native');
          try {
            await viewer.waitForFunction(() => document.documentElement.dataset.connection === 'connected', undefined, { timeout: 15000 });
            await viewer.waitForTimeout(1500);
            report.native.viewer = await viewer.evaluate(() => ({ status: document.documentElement.dataset.connection, state: window.nativeViewer.state(),
              message: document.querySelector('#connection').textContent }));
            if (values.interact) {
              report.native.interactionStage = 'focus-search';
              const request = async (operation, credential, body) => {
                const response = await fetch(`${base}/api/sessions/${native.id}/${operation}`, { method: body ? 'POST' : 'GET',
                  headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                  ...(body ? { body: JSON.stringify(body) } : {}) });
                const value = await response.json(); if (!response.ok) throw new Error(value.error.message); return value;
              };
              await request('actions', native.agentToken, { epoch: native.epoch, actionId: 'probe-focus',
                action: { type: 'fill', selector: 'input.nav-search-input', value: '' } });
              const focused = await request('observe', native.viewerToken);
              if (focused.activeInput?.role !== 'input') throw new Error('Search field did not receive focus');
              const revision = service.manager.get(native.id).frames.revision;
              report.native.interactionStage = 'present-focused-frame';
              const fault = service.manager.get(native.id).frames.fault;
              if (fault) throw new Error(fault);
              await viewer.waitForFunction(revision => window.nativeViewer.state().client?.presented?.revision >= revision, revision, { timeout: 8000 });
              report.native.interactionStage = 'take-control';
              await viewer.locator('#take').click();
              await viewer.waitForFunction(() => window.nativeViewer.state().control.owner === 'human', undefined, { timeout: 8000 });
              report.native.interactionStage = 'coordinate-focus';
              const canvas = viewer.locator('#desktop'), bounds = await canvas.boundingBox();
              // Header search coordinates observed in the native 960x720
              // preview. This test oracle never contributes drawing data.
              const pointers = await viewer.evaluate(() => window.nativeViewer.state().input.pointers);
              let clickAttempts = 0, accepted = false;
              while (++clickAttempts <= 4) {
                await canvas.click({ position: { x: 540 * bounds.width / 960, y: 32 * bounds.height / 720 } });
                await viewer.waitForFunction(() => window.nativeViewer.state().pendingInputs === 0, undefined, { timeout: 8000 });
                const input = await viewer.evaluate(() => window.nativeViewer.state().input);
                if (input.pointers > pointers) { accepted = true; break; }
                if (!['STALE_FRAME', 'FRAME_CATCHING_UP'].includes(input.lastError)) throw new Error('Coordinate input was not accepted: ' + input.lastError);
                // A new test gesture uses the newly presented frame. The
                // product never retries stale coordinates automatically.
                await viewer.waitForTimeout(120);
              }
              if (!accepted) throw new Error('Coordinate focus kept changing before it could be accepted');
              const clicked = await request('observe', native.viewerToken);
              if (clicked.activeInput?.role !== 'input') throw new Error('Accepted coordinate did not focus the real input');
              report.native.coordinateFocus = { passed: true, attempts: clickAttempts };
              report.native.interactionStage = 'direct-keyboard';
              await viewer.keyboard.type('vd probe');
              const deadline = Date.now() + 10000; let observed;
              do {
                guard.check(); observed = await request('observe', native.viewerToken);
                if (observed.activeInput?.value === 'vd probe') break;
                await viewer.waitForTimeout(100);
              } while (Date.now() < deadline);
              if (observed.activeInput?.value !== 'vd probe' || observed.url !== report.url) throw new Error('Direct input did not reach the unchanged public page');
              await viewer.waitForFunction(() => window.nativeViewer.state().pendingInputs === 0 && document.documentElement.dataset.connection === 'connected', undefined, { timeout: 8000 });
              if (await viewer.locator('#notice').evaluate(element => element.classList.contains('error')))
                throw new Error('Input completed with a remaining viewer error');
              report.native.interaction = { passed: true, directHumanInput: true, characters: 8, urlUnchanged: true,
                selectedSource: await viewer.locator('#fixture').inputValue(),
                state: await viewer.evaluate(() => window.nativeViewer.state()) };
            }
            await viewer.screenshot({ path: join(output, 'native-viewer.png'), fullPage: true });
          } catch (error) {
            report.native.presentationError = error.message;
            report.native.failureFrames = service.manager.get(native.id).frames.stats;
            await writeFile(join(output, 'producer-frame.json'), JSON.stringify(service.manager.get(native.id).frames.latest?.frame));
            try { await writeFile(join(output, 'viewer-frame.json'), JSON.stringify(await viewer.evaluate(() => window.nativeViewer.frame()))); } catch {}
            try { report.native.failureViewer = await viewer.evaluate(() => ({ status: document.documentElement.dataset.connection,
              state: window.nativeViewer.state(), message: document.querySelector('#connection').textContent, notice: document.querySelector('#notice').textContent })); } catch {}
          }
          guard.check(); await release();
        } finally { await context.close().catch(() => {}); }
      }
      guard.check(); await ordinaryPage(browser);
    }
    report.status = values.interact && (!report.native.interaction?.passed || report.native.presentationError) ? 'public-page-interaction-failed'
      : report.native.viewer?.status === 'connected' ? 'public-page-preview-only'
      : response.ok && !values.viewer ? 'native-frame-export-only' : 'native-site-not-supported';
  }
} catch (error) { report.errors.push(error.message); report.status = guard?.stopped ? 'safety-stopped' : 'probe-failed'; }
finally {
  await browserServer?.close().catch(() => {}); await service?.close().catch(() => {});
  if (guard) {
    if (guard.stopped) report.status = 'safety-stopped';
    report.safety = { stopped: guard.stopped, baseline: guard.baseline, samples: guard.samples }; await guard.close();
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, native: report.native, ordinary: report.ordinary, errors: report.errors, output }, null, 2));
process.exitCode = ['public-page-preview-only', 'native-frame-export-only', 'native-site-not-supported', 'ordinary-page-only'].includes(report.status) ? 0 : 1;
