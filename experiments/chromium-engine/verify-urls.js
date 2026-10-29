import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createService } from '../../src/server.js';
import { verifiedEngine } from './verified.js';
import { browserProcessArgs } from './browser-runtime.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, canvaskit: { type: 'string' }, output: { type: 'string' } } });
if (!values.root || !values.output) throw new Error('Pass --root and --output; run with the combined producer/viewer watchdog');
const output = resolve(values.output), dataDir = await mkdtemp(join(tmpdir(), 'vd-url-verify-'));
await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', steps: [], errors: [],
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'Bilibili homepage and search URL through the actual local viewer, one execution worker at a time. Static images; no video or strict pixel-equivalence claim.' };
const check = (condition, message) => { if (!condition) throw new Error(message); };
const save = () => writeFile(join(output, 'url-report.json'), JSON.stringify(report, null, 2) + '\n');
let service, browserServer, browser, page, liveWorkers = 0, peakWorkers = 0;
try {
  const engine = await verifiedEngine(values.root, { requireStream: true });
  report.build = { revision: engine.source.revision, patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256 };
  const profileId = 'url-preview-profile', marker = randomUUID(), profileFile = join(dataDir, profileId + '.json');
  await writeFile(profileFile, JSON.stringify({ version: 1, profileId, backend: 'chromium', state: {
    kind: 'chromium-storage-v1', storageState: {
      cookies: [{ name: 'vd_url_test', value: marker, domain: '.bilibili.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }],
      origins: [{ origin: 'https://www.bilibili.com', localStorage: [{ name: 'vd_url_test', value: marker }] }],
    } } }), { mode: 0o600 });
  service = createService({ dataDir, adminToken: 'test-admin', maxActive: 1,
    onWorker(worker) { peakWorkers = Math.max(peakWorkers, ++liveWorkers); worker.exited.then(() => liveWorkers--); },
    chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: 1, externalSites: true } });
  const base = await service.listen(0);
  browserServer = await chromium.launchServer({ executablePath: engine.binary, headless: true, args: browserProcessArgs(), timeout: 15000 });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext({ viewport: { width: 1180, height: 1100 }, deviceScaleFactor: 1 });
  await context.addInitScript(profileId => {
    if (!sessionStorage.getItem('vd-native-target')) sessionStorage.setItem('vd-native-target', JSON.stringify({ profileId, url: 'https://www.bilibili.com/' }));
  }, profileId);
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base + '/native'); await page.locator('#admin-token').fill('test-admin');
  const current = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('vd-native-viewer') || 'null'));
  async function opened(previousId) {
    await page.waitForFunction(previousId => {
      const value = JSON.parse(sessionStorage.getItem('vd-native-viewer') || 'null');
      return (!document.querySelector('#url-error').hidden || value?.id && value.id !== previousId) && !document.querySelector('#open-url').disabled;
    }, previousId, { timeout: 40000 });
    check(await page.locator('#url-error').isHidden(), 'URL open failed: ' + await page.locator('#url-error').textContent());
    await page.waitForFunction(() => document.documentElement.dataset.connection === 'connected' && Boolean(window.nativeViewer?.state().client?.presented),
      undefined, { timeout: 20000 });
    return current();
  }
  await page.locator('#target-url').fill('www.bilibili.com/'); await page.locator('#target-url').press('Enter');
  const first = await opened(null), firstInternal = service.manager.get(first.id);
  check(first.url === 'https://www.bilibili.com/' && first.profileId === profileId, 'Homepage URL/profile binding failed');
  await page.locator('#take').click();
  await page.waitForFunction(() => window.nativeViewer.state().control.owner === 'human');
  await page.locator('#desktop').screenshot({ path: join(output, 'homepage-local-native.png') });
  report.homepage = { url: first.url, presented: await page.evaluate(() => window.nativeViewer.state().client.presented),
    imageAnimationPolicy: 'first-frame' };
  report.steps.push('URL shorthand plus Enter creates the Bilibili native homepage and receives a rendered ACK'); await save();

  await rm(profileFile); // Replacement must save the live state, rather than reuse the seed file.
  const workerPid = firstInternal.worker.child.pid;
  await page.locator('#target-url').fill('https://127.0.0.1/admin'); await page.locator('#target-url').press('Enter');
  await page.locator('#url-error').waitFor({ state: 'visible' });
  check((await current()).id === first.id && firstInternal.state === 'ACTIVE' && firstInternal.worker.child.pid === workerPid && peakWorkers === 1,
    'Invalid URL disrupted the existing native session');
  check(await page.locator('#target-url').getAttribute('aria-invalid') === 'true', 'Invalid URL lacks an accessible error');
  report.invalidUrlRetainsPage = true;
  report.steps.push('Invalid URL shows an inline accessible error without stopping or replacing the active page'); await save();

  const searchUrl = 'https://search.bilibili.com/all?keyword=virtual%20desktop';
  await page.locator('#target-url').fill(searchUrl); await page.locator('#target-url').press('Enter');
  const second = await opened(first.id), secondInternal = service.manager.get(second.id);
  check(second.profileId === first.profileId && second.fixture === 'bilibili' && second.url === searchUrl, 'Search URL/path/query/profile was not preserved');
  check(firstInternal.state === 'COLD' && firstInternal.worker.child.exitCode !== null, 'Previous worker did not stop before replacement');
  check((await page.evaluate(() => window.nativeViewer.state().control.owner)) === 'human', 'Replacement lost human takeover');
  const saved = JSON.parse(await readFile(profileFile, 'utf8')), restored = await secondInternal.worker.call('save');
  const hasCookie = state => state.storageState.cookies.some(cookie => cookie.name === 'vd_url_test' && cookie.value === marker);
  const hasLocalStorage = state => state.storageState.origins.some(origin => origin.origin === 'https://www.bilibili.com' &&
    origin.localStorage.some(item => item.name === 'vd_url_test' && item.value === marker));
  report.profile = { sameProfile: true, savedFromLivePage: true, privateFile: ((await stat(profileFile)).mode & 0o777) === 0o600,
    cookieRestored: hasCookie(saved.state) && hasCookie(restored), localStorageRestored: hasLocalStorage(saved.state) && hasLocalStorage(restored) };
  check(Object.values(report.profile).every(Boolean), 'Cookies/localStorage were not privately saved and restored');
  report.search = { url: second.url, presented: await page.evaluate(() => window.nativeViewer.state().client.presented),
    oldWorkerStopped: true, humanTakeoverRetained: true, peakNativeWorkers: peakWorkers,
    input: await page.evaluate(() => window.nativeViewer.state().input) };
  check(peakWorkers === 1 && report.search.input.accepted === 0, 'URL entry leaked remote input or overlapped execution workers');
  await page.locator('#desktop').screenshot({ path: join(output, 'search-local-native.png') });
  report.steps.push('Search URL replaces the execution browser sequentially, preserving profile cookies/localStorage and human takeover'); await save();

  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.connection === 'connected' && Boolean(window.nativeViewer?.state().client?.presented),
    undefined, { timeout: 20000 });
  check((await current()).id === second.id && await page.locator('#target-url').inputValue() === searchUrl && peakWorkers === 1,
    'Viewer reload lost the URL or allocated a new execution browser');
  await page.setViewportSize({ width: 390, height: 1000 });
  report.narrowLayout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    inputWidth: document.querySelector('#target-url').getBoundingClientRect().width,
    buttonHeight: document.querySelector('#open-url').getBoundingClientRect().height }));
  check(report.narrowLayout.scrollWidth <= report.narrowLayout.width + 1 && report.narrowLayout.inputWidth > 200 && report.narrowLayout.buttonHeight >= 44,
    'URL toolbar overflows or becomes unusable on a narrow viewport');
  await page.screenshot({ path: join(output, 'url-narrow.png') });
  report.steps.push('Reload restores the active URL/session; the URL field and Open button fit a 390px viewport');
  check(report.errors.length === 0, 'Browser reported JavaScript errors');
  report.status = 'native-url-preview-candidate';
} catch (error) {
  report.status = 'url-preview-failed'; report.errors.push(error.message);
  if (page) {
    report.ui = await page.evaluate(() => ({ connection: document.documentElement.dataset.connection,
      message: document.querySelector('#connection')?.textContent, urlError: document.querySelector('#url-error')?.textContent,
      notice: document.querySelector('#notice')?.textContent })).catch(() => null);
    await page.screenshot({ path: join(output, 'url-failure.png'), timeout: 5000 }).catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {}); await browserServer?.close().catch(() => {}); await service?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ status: report.status, steps: report.steps, errors: report.errors, output }, null, 2));
process.exitCode = report.status === 'native-url-preview-candidate' ? 0 : 1;
