import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { verifiedEngine } from './verified.js';
import { ChromiumSession } from './session.js';
import { allowedSiteRequest, externalSites } from './sites.js';
import { browserProcessArgs } from './browser-runtime.js';
import { comparePixels, crop, decoded } from '../chromium-paint/verify.js';
import { settlePage } from '../chromium-paint/capture.js';
import { embeddedFonts } from './font-inspect.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, canvaskit: { type: 'string' }, startup: { type: 'boolean', default: false } } });
if (!values.root || !values.output) throw new Error('Pass --root and --output');
const output = resolve(values.output); await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'running', kind: values.startup ? 'startup' : 'raster', errors: [],
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: values.startup ? 'Fresh IANA startup metadata diagnosis; no guessed binding or public-site acceptance.' :
    'Separate ordinary-mode diagnostic: re-rasterize the archived original CERN SKP on macOS and compare to CanvasKit. Diagnostic pixels never enter native production transport. CSS smoothing changes are ablations, never a substituted acceptance reference.' };
const save = () => writeFile(join(output, 'diagnostic-report.json'), JSON.stringify(report, null, 2) + '\n'); await save();
const check = (ok, message) => { if (!ok) throw new Error(message); };
function strict(reference, actual) {
  const whole = comparePixels(reference, actual), regions = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const bounds = { x: x * 320, y: y * 240, width: 320, height: 240 };
    regions.push({ bounds, ...comparePixels(crop(reference, bounds), crop(actual, bounds)) });
  }
  return { passed: whole.passed && regions.every(item => item.passed), whole, regions };
}
function overWhite(image) {
  const data = new Uint8ClampedArray(image.data);
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3] / 255;
    for (let channel = 0; channel < 3; channel++) data[at + channel] = Math.round(data[at + channel] * alpha + 255 * (1 - alpha));
    data[at + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}
let server, browser, native;
try {
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, binarySha256: engine.state.binarySha256, patchSha256: engine.patchSha256 };
  if (values.startup) {
    report.faults = [];
    native = new ChromiumSession({ onFrame() {}, onBrowser() {}, onFault(message) { if (report.faults.length < 8) report.faults.push(message); },
      async onStartupTrace({ events, url, frame, phase = 'navigation' }) {
        const batch = { phase, browserPid: native.browserPid, resolvedUrl: url, cdpFrame: frame, events: events.flatMap((event, eventIndex) => {
          const data = event.args?.data;
          if (event.name === 'TracingStartedInBrowser') return [{ eventIndex, name: event.name, cat: event.cat, pid: event.pid, ts: event.ts, frames: data?.frames }];
          if (!['FrameCommittedInBrowser', 'ProcessReadyInBrowser', 'CommitLoad', 'SetLayerTreeId'].includes(event.name)) return [];
          return [{ eventIndex, name: event.name, cat: event.cat, pid: event.pid, ts: event.ts, data }];
        }) };
        (report.startupTraces ||= []).push(batch); report.startup ||= batch;
        await save();
      } });
    try { report.native = await native.start({ root: values.root, expectedArtifactsSha256: engine.artifactsSha256, expectedPatchSha256: engine.patchSha256,
      site: 'iana', url: externalSites.iana.url, allowedPaths: [], viewport: { width: 960, height: 720 } }); }
    catch (error) { report.nativeError = error.message; report.provenance = native.startupProvenance; report.candidates = [...native.candidates.values()].map(item => ({ pid: item.pid, ts: item.ts,
      error: item.error, treeId: item.snapshot?.tree_id, unsupported: item.snapshot?.unsupported })); }
  } else {
    const directory = resolve('test-results/public-sites-20261029/cern-final');
    const manifest = JSON.parse(await readFile(join(directory, 'frame-capture.json'), 'utf8')), stage = manifest.stages[0];
    check(stage.frame.surfaces.length === 1 && stage.frame.surfaces[0].items.length === 1, 'Diagnostic expects one CERN picture');
    const item = stage.frame.surfaces[0].items[0];
    check(item.kind === 'picture' && item.opacity === 1 && JSON.stringify(item.transform) === JSON.stringify([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), 'Diagnostic expects an untranslated picture');
    const descriptor = stage.frame.resources.find(entry => entry.id === item.resource), skp = await readFile(join(directory, descriptor.path));
    check(createHash('sha256').update(skp).digest('hex') === descriptor.id, 'Archived SKP fingerprint differs');
    report.record = { id: descriptor.id, bytes: skp.length, fonts: embeddedFonts(skp) };
    const reference = await decoded(await readFile(join(directory, 'ordinary-r0-before.png'))), kit = await decoded(await readFile(join(directory, 'client-r0-before.png')));
    report.referenceRepeat = strict(reference, await decoded(await readFile(join(directory, 'ordinary-r1-before.png'))));
    report.canvasKitOriginal = strict(reference, kit);
    server = await chromium.launchServer({ executablePath: engine.binary, headless: true, timeout: 15000, args: ['--enable-automation', ...browserProcessArgs()] });
    browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    await cdp.send('LayerTree.enable');
    const { snapshotId } = await cdp.send('LayerTree.loadSnapshot', { tiles: [{ x: 0, y: 0, picture: skp.toString('base64') }] });
    let mac;
    try {
      const { dataURL } = await cdp.send('LayerTree.replaySnapshot', { snapshotId, scale: 1 });
      const png = Buffer.from(dataURL.split(',')[1], 'base64'); await writeFile(join(output, 'mac-skp-replay.png'), png);
      mac = overWhite(await decoded(png));
      report.macOriginal = strict(reference, mac); report.macVsCanvasKit = strict(mac, kit);
    } finally { await cdp.send('LayerTree.releaseSnapshot', { snapshotId }); }
    await context.route('**/*', route => { const request = route.request(); return allowedSiteRequest('cern', request.url(), { navigation: request.isNavigationRequest(), method: request.method() }) ? route.continue() : route.abort(); });
    await page.goto(externalSites.cern.url, { waitUntil: 'domcontentloaded', timeout: 15000 }); await settlePage(page);
    const textHash = await page.evaluate(() => document.body.innerText);
    report.freshTextMatches = createHash('sha256').update(textHash).digest('hex') === stage.state.textSha256;
    check(report.freshTextMatches, 'CERN live text changed; CSS ablation is not comparable');
    report.smoothingAblations = [];
    let style;
    for (const smoothing of ['auto', 'antialiased', 'subpixel-antialiased']) {
      await style?.evaluate(node => node.remove());
      style = await page.addStyleTag({ content: `* { -webkit-font-smoothing:${smoothing} !important; }` }); await settlePage(page);
      const bytes = await page.screenshot({ path: join(output, `reference-${smoothing}.png`), timeout: 5000 });
      const image = await decoded(bytes);
      report.smoothingAblations.push({ smoothing, actual: await page.evaluate(() => getComputedStyle(document.body).webkitFontSmoothing),
        againstArchivedOriginal: strict(reference, image), againstCanvasKit: strict(image, kit), againstMacReplay: strict(image, mac) });
      await save();
    }
  }
  report.status = 'native-diagnostics-complete';
} catch (error) { report.status = 'native-diagnostics-failed'; report.errors.push(error.message.split('\n')[0]); }
finally { await native?.close().catch(() => {}); await browser?.close().catch(() => {}); await server?.close().catch(() => {}); report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ status: report.status, kind: report.kind, nativeError: report.nativeError, errors: report.errors }));
process.exitCode = report.status === 'native-diagnostics-complete' ? 0 : 1;
