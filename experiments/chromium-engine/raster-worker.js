// Conventional server-raster control used ONLY by the bounded benchmark.
// It is not selectable through the product session API.
import { chromium } from 'playwright';
import { verifiedEngine } from './verified.js';
import { browserAction } from './browser-actions.js';
import { settlePage } from '../chromium-paint/capture.js';

let server, page, viewport, stopping = false;
async function frame() { return page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000 }); }
async function dispatch(method, params) {
  if (method === 'init') {
    const verified = await verifiedEngine(params.root);
    if (verified.artifactsSha256 !== params.expectedArtifactsSha256 || verified.patchSha256 !== params.expectedPatchSha256) throw new Error('Build changed');
    viewport = params.viewport;
    server = await chromium.launchServer({ executablePath: verified.binary, headless: true, host: '127.0.0.1', chromiumSandbox: false });
    process.send({ event: 'native-browser', pid: server.process().pid });
    const browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' });
    const origin = new URL(params.url).origin, paths = new Set(params.allowedPaths);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin && paths.has(url.pathname) && route.request().method() === 'GET' ? route.continue() : route.abort();
    });
    page = await context.newPage(); await page.goto(params.url, { timeout: 15000 }); await settlePage(page);
    return { jpeg: await frame() };
  }
  if (method === 'action') {
    await browserAction(page, viewport, params.action); await settlePage(page);
    return { actionId: params.actionId, jpeg: await frame() };
  }
  if (method === 'observe') return { text: await page.locator('body').innerText() };
  throw new Error('Unsupported raster benchmark method');
}
let chain = Promise.resolve();
process.on('message', ({ id, method, params }) => {
  chain = chain.then(async () => {
    try { process.send({ id, result: await dispatch(method, params) }); }
    catch (error) { process.send({ id, error: { status: 502, code: 'RASTER_BENCHMARK_ERROR', message: error.message } }); }
  });
});
async function close() {
  if (stopping) return; stopping = true;
  const timer = setTimeout(() => process.exit(1), 3000); timer.unref();
  await server?.close().catch(() => {}); process.exit(0);
}
process.on('disconnect', close); process.once('SIGTERM', close); process.once('SIGINT', close);
