import http from 'node:http';
import { mkdir, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createCanvas } from '@napi-rs/canvas';
import { createNativeStream } from './native-stream.js';
import { verifiedEngine } from './verified.js';
import { nativePageRoute } from './page-route.js';
import { normalizeNativeFrame } from '../chromium-paint/native-frame.js';
import { captureLaunchArgs, recordTrace, settlePage } from '../chromium-paint/capture.js';
import { embeddedFonts } from './font-inspect.js';
import { createFrameLab } from '../chromium-paint/frame-server.js';
import { browserProcessArgs } from './browser-runtime.js';
import { comparePixels, crop, decoded } from '../chromium-paint/verify.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, canvaskit: { type: 'string' }, images: { type: 'boolean', default: false } } });
if (!values.root || !values.output) throw new Error('Pass --root and --output');
const output = resolve(values.output); await mkdir(output, { recursive: true });
await mkdir(join(output, 'fonts'), { recursive: true });
const font = await readFile(new URL('../chromium-paint/fonts/fixture-sans.otf', import.meta.url));
const tile = createCanvas(2, 2), paint = tile.getContext('2d'); paint.fillStyle = '#cc3300'; paint.fillRect(0, 0, 2, 2);
const png = tile.toBuffer('image/png');
const cases = values.images ? [
  { id: 'no-image', family: 'Probe', text: 'Image control' },
  { id: 'png-image', family: 'Probe', text: 'Image control', image: '<img id="image" src="/pixel.png" width="32" height="32">' },
  { id: 'png-background', family: 'Probe', text: 'Image control', image: '<div style="width:32px;height:32px;background:url(/pixel.png)"></div>' },
  { id: 'inline-vector', family: 'Probe', text: 'Image control', image: '<svg width="32" height="32"><rect width="32" height="32" fill="#c30"/></svg>' },
] : [
  { id: 'fixture-latin', family: 'Probe', text: 'Native font probe ABC abc 123' },
  { id: 'serif-latin', family: '"Times New Roman"', text: 'Native font probe ABC abc 123' },
  { id: 'default-serif', family: 'serif', text: 'Native font probe ABC abc 123' },
  { id: 'default-serif-bold', family: 'serif', text: 'Native font probe ABC abc 123', style: 'font-weight:700' },
  { id: 'system-latin', family: 'system-ui', text: 'Native font probe ABC abc 123' },
  { id: 'system-cjk', family: 'system-ui', text: '中文字体记录测试' },
  { id: 'fixture-cjk-fallback', family: 'Probe', text: '中文字体记录测试' },
  { id: 'system-arabic', family: 'system-ui', text: 'اختبار الخط العربي' },
  { id: 'system-variable', family: 'system-ui', text: 'Native font probe ABC abc 123', style: 'font-weight:650;font-variation-settings:"wght" 650,"opsz" 24' },
];
const report = { version: 1, startedAt: new Date().toISOString(), status: 'running', kind: values.images ? 'images' : 'fonts', cases: [], errors: [],
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'Synthetic loopback-only causal diagnostics, not public-site acceptance. Original fonts/PNG/vector cases are deliberate controlled inputs. No limit change, screenshot fallback or altered web-site pass.' };
const save = () => writeFile(join(output, 'diagnostic-report.json'), JSON.stringify(report, null, 2) + '\n'); await save();
async function fontFormat(path, id) {
  const file = await open(path);
  try {
    const header = Buffer.alloc(12); await file.read(header, 0, header.length, 0);
    if (header.subarray(0, 8).toString() !== 'vdglyph1') return { id, format: 'sfnt' };
    const count = Buffer.alloc(4); await file.read(count, 0, 4, 12 + header.readUInt32LE(8) + 64);
    return { id, format: 'native-outlines', glyphs: count.readUInt32LE() };
  } finally { await file.close(); }
}
const server = http.createServer((request, response) => {
  const address = new URL(request.url, 'http://127.0.0.1');
  if (request.method !== 'GET') { response.writeHead(405); return response.end(); }
  if (address.pathname === '/font.otf') { response.writeHead(200, { 'Content-Type': 'font/otf' }); return response.end(font); }
  if (address.pathname === '/pixel.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(png); }
  const item = cases.find(item => item.id === address.searchParams.get('case'));
  if (address.pathname !== '/probe' || !item) { response.writeHead(404); return response.end(); }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src 'none'" });
  response.end(`<!doctype html><meta charset="utf-8"><title>Native diagnostic ${item.id}</title><style>@font-face{font-family:Probe;src:url(/font.otf)}body{margin:24px;background:white;color:black}#probe{font:16px ${item.family};-webkit-font-smoothing:antialiased;${item.style || ''}}</style><p id="probe">${item.text}</p>${item.image || ''}`);
});
let browserServer, browser, stream;
async function replay(item, result, executablePath) {
  const directory = join(output, item.id), lab = createFrameLab({ outputDir: directory, canvasKitDirectory: values.canvaskit });
  let local;
  try {
    const baseUrl = await lab.listen();
    local = await chromium.launch({ executablePath, headless: true, args: browserProcessArgs() });
    const context = await local.newContext({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.waitForFunction(() => ['ready', 'unsupported'].includes(document.documentElement.dataset.status), undefined, { timeout: 15000 });
    const details = JSON.parse(await page.locator('#result').textContent());
    if (await page.locator('html').getAttribute('data-status') !== 'ready') throw new Error(details.error || 'Font replay failed');
    const picture = Buffer.from((await page.locator('#skp').evaluate(canvas => canvas.toDataURL('image/png'))).split(',')[1], 'base64');
    await writeFile(join(directory, 'client.png'), picture);
    // Independent local ordinary-mode reference, after the native producer
    // exits. Pixels and DOM bounds are diagnostics only, never frame payloads.
    const reference = await context.newPage();
    await reference.goto(result.url); await reference.evaluate(() => document.fonts.ready);
    const bounds = await reference.locator('#probe').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { x: Math.floor(rect.x) - 2, y: Math.floor(rect.y) - 2, width: Math.ceil(rect.width) + 4, height: Math.ceil(rect.height) + 4 };
    });
    const expected = await reference.screenshot({ path: join(directory, 'reference.png') });
    const actualImage = await decoded(picture), expectedImage = await decoded(expected);
    result.replay = { decoded: true, details, visual: comparePixels(expectedImage, actualImage),
      textRegion: { bounds, ...comparePixels(crop(expectedImage, bounds), crop(actualImage, bounds)) } };
    if (item.id === 'system-cjk') {
      result.missingGlyphProbe = await page.evaluate(async ({ font, pictureId }) => {
        const asset = new Uint8Array(await (await fetch('/' + font.path)).arrayBuffer());
        if (new TextDecoder().decode(asset.subarray(0, 8)) !== 'vdglyph1') return { applicable: false };
        const view = new DataView(asset.buffer), countAt = 12 + view.getUint32(8, true) + 64;
        const count = view.getUint32(countAt, true), records = []; let offset = countAt + 4;
        for (let i = 0; i < count; i++) {
          const bytes = 12 + view.getUint32(offset + 8, true);
          records.push({ offset, bytes, glyph: view.getUint32(offset, true) }); offset += bytes;
        }
        if (count < 3 || offset !== asset.length) throw new Error('Invalid outline diagnostic input');
        // Remove a middle glyph, retaining the highest original glyph ID and
        // a valid binary structure. Rehash the asset and its SKP reference so
        // this exercises coverage rejection after successful hash validation.
        const removed = records[1], altered = new Uint8Array(asset.length - removed.bytes);
        altered.set(asset.subarray(0, removed.offset)); altered.set(asset.subarray(removed.offset + removed.bytes), removed.offset);
        new DataView(altered.buffer).setUint32(countAt, count - 1, true);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', altered))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const skp = new Uint8Array(await (await fetch('/pictures/' + pictureId + '.skp')).arrayBuffer());
        const original = new TextEncoder().encode(font.id), replacement = new TextEncoder().encode(hash); let replacements = 0;
        for (let at = 0; at <= skp.length - 64; at++) {
          if (original.every((byte, i) => skp[at + i] === byte)) { skp.set(replacement, at); replacements++; at += 63; }
        }
        const kit = await window.CanvasKitInit({ locateFile: name => '/' + name }), registry = new kit.RemoteFontRegistry();
        let picture;
        try {
          const fontPointer = kit._malloc(altered.length); kit.HEAPU8.set(altered, fontPointer);
          if (!registry._addFont(hash, fontPointer, altered.length)) throw new Error('Altered font registration failed before coverage check');
          const picturePointer = kit._malloc(skp.length); kit.HEAPU8.set(skp, picturePointer);
          picture = registry._makePicture(picturePointer, skp.length);
          return { applicable: true, rejected: !picture, replacements, removedGlyph: removed.glyph, before: count, after: count - 1 };
        } finally { picture?.delete(); registry.delete(); }
      }, { font: result.fontAssets[0], pictureId: result.resources[0].id });
      if (result.missingGlyphProbe.applicable && (!result.missingGlyphProbe.rejected || result.missingGlyphProbe.replacements !== 1)) throw new Error('Incomplete outline font was accepted');
    }
  } finally { await local?.close(); await lab.close(); }
}
try {
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, binarySha256: engine.state.binarySha256, patchSha256: engine.patchSha256 };
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const item of cases) {
    const result = { id: item.id, cssFamily: item.family, text: item.text, status: 'running' }; report.cases.push(result); await save();
    const messages = new Map();
    try {
      stream = await createNativeStream(message => { const key = `${message.pid}:${message.snapshot?.tree_id ?? 'error'}`;
        if (!messages.has(key) && messages.size >= 4) messages.delete(messages.keys().next().value); messages.set(key, message); });
      browserServer = await chromium.launchServer({ executablePath: engine.binary, headless: true, chromiumSandbox: false, timeout: 15000,
        args: captureLaunchArgs({ remotePaint: true, noDisplay: true, producerBufferBytes: 8388608 }), env: { ...process.env, ...stream.environment } });
      browser = await chromium.connect(browserServer.wsEndpoint());
      const context = await browser.newContext({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin && route.request().method() === 'GET' ? route.continue() : route.abort());
      const page = await context.newPage(), cdp = await context.newCDPSession(page);
      const url = origin + '/probe?case=' + item.id;
      result.url = url;
      const fontReady = 'font-ready-' + item.id;
      const trace = await recordTrace(cdp, async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(() => document.fonts.ready); await page.evaluate(name => performance.mark(name), fontReady);
        await page.setViewportSize({ width: 961, height: 720 }); await settlePage(page);
        await page.setViewportSize({ width: 960, height: 720 }); await settlePage(page); },
      { traceConfig: { recordMode: 'recordAsMuchAsPossible', traceBufferSizeInKb: 4096,
        includedCategories: ['disabled-by-default-devtools.timeline', 'blink.user_timing'], excludedCategories: ['*'] } });
      const { frameTree } = await cdp.send('Page.getFrameTree');
      result.route = nativePageRoute(trace.events, url, frameTree.frame.id);
      result.fontReadyTimestamp = trace.events.find(event => event.name === fontReady && result.route.rendererPids.includes(event.pid))?.ts;
      if (!Number.isFinite(result.fontReadyTimestamp)) throw new Error('Missing native font-ready timing provenance');
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument'), { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#probe' });
      result.platformFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
      result.imageState = await page.evaluate(() => [...document.images].map(image => ({ complete: image.complete, naturalWidth: image.naturalWidth })));
      const deadline = Date.now() + 5000; let current;
      while (Date.now() < deadline) {
        current = [...messages.values()].filter(message => message.pid === result.route.route.pid && message.ts >= result.fontReadyTimestamp &&
          (!message.snapshot || message.snapshot.tree_id === result.route.route.treeId && message.snapshot.viewport?.[2] === 960))
          .sort((a, b) => b.ts - a.ts)[0];
        if (current?.error || current?.snapshot?.unsupported_count > 0 ||
            current?.snapshot?.entries?.some(entry => entry.record?.font_count > 0)) break;
        current = null; await new Promise(resolve => setTimeout(resolve, 20));
      }
      result.stream = stream.stats;
      if (!current) throw new Error('No diagnostic native message');
      result.nativeError = current.error; result.unsupported = current.snapshot?.unsupported;
      if (current.snapshot) {
        try {
          const normalized = normalizeNativeFrame({ name: 'VirtualDesktop.RemotePaintFrame', cat: 'cc', pid: current.pid, ts: current.ts, args: { snapshot: current.snapshot } });
          result.nativeSupported = true; result.resources = []; result.fontAssets = [...normalized.fonts.values()];
          result.fontFormats = [];
          result.nativeMessageBytes = Buffer.byteLength(JSON.stringify(current));
          for (const asset of normalized.fonts.values()) {
            const path = stream.fontResource(asset.id).filePath;
            result.fontFormats.push(await fontFormat(path, asset.id));
            await copyFile(path, join(output, asset.path));
          }
          if (values.canvaskit) {
            const directory = join(output, item.id);
            await mkdir(join(directory, 'pictures'), { recursive: true }); await mkdir(join(directory, 'fonts'), { recursive: true });
            for (const asset of normalized.fonts.values()) await copyFile(stream.fontResource(asset.id).filePath, join(directory, asset.path));
            for (const [id, bytes] of normalized.bytes) await writeFile(join(directory, `pictures/${id}.skp`), bytes);
            await writeFile(join(directory, 'frame-capture.json'), JSON.stringify({ version: 1, viewport: normalized.frame.viewport,
              stages: [{ name: item.id, frame: normalized.frame }] }, null, 2));
          }
          for (const [id, bytes] of normalized.bytes) {
            const fonts = embeddedFonts(bytes);
            result.resources.push({ id, bytes: bytes.length, fonts, embeddedFontBytes: fonts.reduce((sum, font) => sum + font.bytes, 0) });
          }
        } catch (error) { result.nativeSupported = false; result.nativeError = error.message; }
      } else result.nativeSupported = false;
      result.status = 'observed';
    } catch (error) { result.status = 'diagnostic-failed'; result.error = error.message.split('\n')[0]; }
    finally { await browser?.close().catch(() => {}); await browserServer?.close().catch(() => {}); await stream?.close(); browser = browserServer = stream = null; await save(); }
    if (values.canvaskit && result.nativeSupported) {
      try { await replay(item, result, engine.binary); }
      catch (error) { result.status = 'diagnostic-failed'; result.replayError = error.message.split('\n')[0]; }
      await save();
    }
  }
  report.status = report.cases.every(item => item.status === 'observed') ? 'native-diagnostics-complete' : 'native-diagnostics-incomplete';
  const assets = new Map(report.cases.flatMap(item => item.fontAssets || []).map(asset => [asset.id, asset]));
  await writeFile(join(output, 'fonts/catalog.json'), JSON.stringify({ version: 1, fonts: [...assets.values()] }, null, 2) + '\n');
} catch (error) { report.errors.push(error.message); report.status = 'native-diagnostics-failed'; }
finally { server.closeAllConnections(); await new Promise(done => server.close(done)); report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ status: report.status, cases: report.cases.map(item => ({ id: item.id, supported: item.nativeSupported, error: item.nativeError || item.error })) }));
process.exitCode = report.status === 'native-diagnostics-complete' ? 0 : 1;
