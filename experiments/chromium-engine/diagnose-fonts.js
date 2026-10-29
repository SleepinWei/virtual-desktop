import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createCanvas } from '@napi-rs/canvas';
import { createNativeStream } from './native-stream.js';
import { verifiedEngine } from './verified.js';
import { nativePageRoute } from './page-route.js';
import { normalizeNativeFrame } from '../chromium-paint/native-frame.js';
import { captureLaunchArgs, recordTrace } from '../chromium-paint/capture.js';
import { embeddedFonts } from './font-inspect.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, canvaskit: { type: 'string' }, images: { type: 'boolean', default: false } } });
if (!values.root || !values.output) throw new Error('Pass --root and --output');
const output = resolve(values.output); await mkdir(output, { recursive: true });
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
  { id: 'system-latin', family: 'system-ui', text: 'Native font probe ABC abc 123' },
  { id: 'system-cjk', family: 'system-ui', text: '中文字体记录测试' },
  { id: 'fixture-cjk-fallback', family: 'Probe', text: '中文字体记录测试' },
  { id: 'system-arabic', family: 'system-ui', text: 'اختبار الخط العربي' },
];
const report = { version: 1, startedAt: new Date().toISOString(), status: 'running', kind: values.images ? 'images' : 'fonts', cases: [], errors: [],
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'Synthetic loopback-only causal diagnostics, not public-site acceptance. Original fonts/PNG/vector cases are deliberate controlled inputs. No limit change, screenshot fallback or altered web-site pass.' };
const save = () => writeFile(join(output, 'diagnostic-report.json'), JSON.stringify(report, null, 2) + '\n'); await save();
const server = http.createServer((request, response) => {
  const address = new URL(request.url, 'http://127.0.0.1');
  if (request.method !== 'GET') { response.writeHead(405); return response.end(); }
  if (address.pathname === '/font.otf') { response.writeHead(200, { 'Content-Type': 'font/otf' }); return response.end(font); }
  if (address.pathname === '/pixel.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(png); }
  const item = cases.find(item => item.id === address.searchParams.get('case'));
  if (address.pathname !== '/probe' || !item) { response.writeHead(404); return response.end(); }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src 'none'" });
  response.end(`<!doctype html><meta charset="utf-8"><title>Native diagnostic ${item.id}</title><style>@font-face{font-family:Probe;src:url(/font.otf)}body{margin:24px;background:white;color:black}#probe{font:16px ${item.family};-webkit-font-smoothing:antialiased}</style><p id="probe">${item.text}</p>${item.image || ''}`);
});
let browserServer, browser, stream;
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
      const trace = await recordTrace(cdp, async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(1000); },
      { traceConfig: { recordMode: 'recordAsMuchAsPossible', traceBufferSizeInKb: 4096, includedCategories: ['disabled-by-default-devtools.timeline'], excludedCategories: ['*'] } });
      const { frameTree } = await cdp.send('Page.getFrameTree');
      result.route = nativePageRoute(trace.events, url, frameTree.frame.id);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument'), { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#probe' });
      result.platformFonts = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
      result.imageState = await page.evaluate(() => [...document.images].map(image => ({ complete: image.complete, naturalWidth: image.naturalWidth })));
      const matching = [...messages.values()].filter(message => message.pid === result.route.route.pid &&
        (!message.snapshot || message.snapshot.tree_id === result.route.route.treeId)).sort((a, b) => b.ts - a.ts);
      const current = matching[0]; result.stream = stream.stats;
      if (!current) throw new Error('No diagnostic native message');
      result.nativeError = current.error; result.unsupported = current.snapshot?.unsupported;
      if (current.snapshot) {
        try {
          const normalized = normalizeNativeFrame({ name: 'VirtualDesktop.RemotePaintFrame', cat: 'cc', pid: current.pid, ts: current.ts, args: { snapshot: current.snapshot } });
          result.nativeSupported = true; result.resources = [];
          for (const [id, bytes] of normalized.bytes) {
            const fonts = embeddedFonts(bytes);
            result.resources.push({ id, bytes: bytes.length, fonts, embeddedFontBytes: fonts.reduce((sum, font) => sum + font.bytes, 0) });
          }
        } catch (error) { result.nativeSupported = false; result.nativeError = error.message; }
      } else result.nativeSupported = false;
      result.status = 'observed';
    } catch (error) { result.status = 'diagnostic-failed'; result.error = error.message.split('\n')[0]; }
    finally { await browser?.close().catch(() => {}); await browserServer?.close().catch(() => {}); await stream?.close(); browser = browserServer = stream = null; await save(); }
  }
  report.status = report.cases.every(item => item.status === 'observed') ? 'native-diagnostics-complete' : 'native-diagnostics-incomplete';
} catch (error) { report.errors.push(error.message); report.status = 'native-diagnostics-failed'; }
finally { server.closeAllConnections(); await new Promise(done => server.close(done)); report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ status: report.status, cases: report.cases.map(item => ({ id: item.id, supported: item.nativeSupported, error: item.nativeError || item.error })) }));
process.exitCode = report.status === 'native-diagnostics-complete' ? 0 : 1;
