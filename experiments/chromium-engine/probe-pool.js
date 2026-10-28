import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '../../src/server.js';
import { NativeFrames } from '../../src/native-frames.js';
import { nativeAllowedPaths } from './assets.js';
import { verifiedEngine } from './verified.js';
import { ChromiumSession } from './session.js';
import { SharedChromiumHost } from './shared-browser.js';
import { startLoadGuard, hostSample } from './load-guard.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, output: { type: 'string', default: 'test-results/native-shared-pool' } } });
if (!values.root || !values.canvaskit) throw new Error('Pass --root and --canvaskit');
const output = resolve(values.output); await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', steps: [], measurements: [], faults: [], errors: [],
  engineSplitGate: 'not-passed', serverRasterBypassed: false,
  scope: 'One shared headless browser, at most two trusted fixture contexts; native records only. No public pool API, viewer/visual pass or hostile-tenant security claim.' };
const save = () => writeFile(join(output, 'pool-report.json'), JSON.stringify(report, null, 2) + '\n');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let guard, service, host, temporary, parameters, base;
const entries = [];
try {
  guard = await startLoadGuard();
  const engine = await verifiedEngine(values.root, { requireStream: true });
  parameters = { root: values.root, expectedArtifactsSha256: engine.artifactsSha256, expectedPatchSha256: engine.patchSha256,
    viewport: { width: 960, height: 720 }, allowedPaths: nativeAllowedPaths };
  report.build = { revision: engine.source.revision, artifactsSha256: engine.artifactsSha256, patchSha256: engine.patchSha256 };
  temporary = await mkdtemp(join(tmpdir(), 'vd-native-pool-'));
  service = createService({ dataDir: temporary, chromium: { root: values.root, canvasKitDirectory: values.canvaskit } });
  base = await service.listen(0);
  host = new SharedChromiumHost({ maxActive: 2, onBrowser(pid, child) { guard.add(pid); child.once('exit', () => guard.remove(pid)); } });
  await host.start(parameters);
  async function create(name) {
    const entry = { name, hub: new NativeFrames(() => ({ owner: 'agent', epoch: 1 })), action: 0, faults: [] };
    entry.session = new ChromiumSession({ sharedHost: host, onFrame: frame => entry.hub.ingest(frame),
      onFault(message, fatal) { entry.faults.push({ message, fatal }); report.faults.push({ name, message, fatal }); entry.hub.unsupported(message, fatal); } });
    entries.push(entry);
    entry.started = await entry.session.start({ ...parameters, url: base + '/live-fixture.html' }); guard.check();
    const target = await entry.session.cdp.send('Target.getTargetInfo'); entry.contextId = target.targetInfo.browserContextId;
    check(entry.started.browserPid === host.browserPid && entry.hub.stats.received > 0 && !entry.hub.stats.fault, 'Missing isolated native frame');
    return entry;
  }
  async function action(entry, action) {
    guard.check(); const result = await entry.session.dispatch('action', { actionId: `${entry.name}-${++entry.action}`, action });
    check(!entry.hub.stats.fault, 'Native fault after input: ' + entry.name); return result;
  }
  async function state(entry) {
    return { ...await entry.session.dispatch('observe'),
      marker: await entry.session.page.evaluate(() => ({ local: localStorage.getItem('pool-marker'), heap: window.poolMarker ?? null })),
      cookies: (await entry.session.context.cookies(base)).filter(cookie => cookie.name === 'pool-marker').map(cookie => cookie.value) };
  }
  async function mark(entry) {
    await entry.session.context.addCookies([{ name: 'pool-marker', value: entry.name, url: base }]);
    await entry.session.page.evaluate(value => { localStorage.setItem('pool-marker', value); window.poolMarker = value; }, entry.name);
  }
  async function sample(phase) {
    await delay(1100); guard.check(); const sampled = await hostSample([process.pid]);
    report.measurements.push({ phase, ...sampled, activeContexts: host.router.stats.active,
      browserPid: host.browserPid, router: host.router.stats }); await save();
  }
  const a = await create('A'); await mark(a);
  await action(a, { type: 'fill', selector: '#message', value: 'Pool session A' });
  await action(a, { type: 'click', selector: '#increment' });
  await sample('one-context');
  const b = await create('B'), freshB = await state(b);
  check(freshB.marker.local === null && freshB.marker.heap === null && freshB.cookies.length === 0 && /Increment\s+0\b/.test(freshB.text), 'New context inherited A state');
  await mark(b); await action(b, { type: 'fill', selector: '#message', value: 'Pool session B' });
  await action(b, { type: 'click', selector: '#increment' });
  const stateA = await state(a), stateB = await state(b);
  check(a.contextId && b.contextId && a.contextId !== b.contextId && a.started.rendererPid !== b.started.rendererPid,
    'Contexts must have distinct context IDs and renderer processes');
  for (const [entry, observed] of [[a, stateA], [b, stateB]]) {
    check(observed.marker.local === entry.name && observed.marker.heap === entry.name && observed.cookies.join() === entry.name,
      'Storage or JS state crossed native context leases');
    check(observed.targets.some(target => target.selector === '#message' && target.value === `Pool session ${entry.name}`), 'Native input crossed contexts');
    check(entry.hub.latest.frame.native.pid === entry.started.rendererPid, 'Native frame crossed renderer identity');
  }
  report.identities = [a, b].map(entry => ({ name: entry.name, browserPid: entry.started.browserPid, rendererPid: entry.started.rendererPid,
    contextId: entry.contextId, frameId: entry.hub.stats.frameId }));
  report.steps.push('Two independent BrowserContexts share one browser PID; renderer PIDs, cookies, localStorage, JS markers, input and native frames remain separate');
  await sample('two-contexts');
  await a.session.close(); a.hub.close();
  await action(b, { type: 'click', selector: '#increment' });
  check(/Increment\s+2\b/.test((await state(b)).text), 'Closing A stopped B');
  const c = await create('C'), freshC = await state(c);
  check(freshC.marker.local === null && freshC.marker.heap === null && freshC.cookies.length === 0 && /Increment\s+0\b/.test(freshC.text), 'Fresh lease retained an earlier user state');
  report.steps.push('Closing one context leaves the other live; its capacity is reused by a fresh context with clean state');
  await sample('replaced-context');
  await Promise.race([c.session.cdp.send('Page.crash').catch(() => {}), delay(1500)]);
  check(c.faults.some(fault => fault.fatal), 'Renderer crash did not terminate its lease');
  await c.session.close(); c.hub.close();
  await action(b, { type: 'click', selector: '#increment' });
  check(/Increment\s+3\b/.test((await state(b)).text), 'Renderer crash affected the other native context');
  report.steps.push('Crashing one renderer terminates its lease while the other context still accepts real input and exports frames');
  const d = await create('D');
  process.kill(-host.browserPid, 'SIGKILL');
  for (let index = 0; index < 50 && ![b, d].every(entry => entry.faults.some(fault => fault.fatal)); index++) await delay(20);
  check([b, d].every(entry => entry.faults.some(fault => fault.fatal)), 'Browser crash was not reported to both remaining leases');
  report.browserCrash = { activeLeases: 2, fatalLeases: [b, d].map(entry => entry.name) };
  report.steps.push('Killing the shared browser invalidates both remaining host leases; browser failure is a shared fault domain');
  guard.check(); report.status = 'shared-native-host-candidate';
} catch (error) { report.errors.push(error.message); report.status = guard?.stopped ? 'safety-stopped' : 'pool-probe-failed'; }
finally {
  for (const entry of entries) { await entry.session?.close().catch(() => {}); entry.hub.close(); }
  if (host) { report.host = { browserPid: host.browserPid, router: host.router.stats, diagnostics: host.diagnostics }; await host.close().catch(() => {}); }
  await service?.close().catch(() => {});
  if (guard) { if (guard.stopped) report.status = 'safety-stopped'; report.safety = { stopped: guard.stopped, baseline: guard.baseline, samples: guard.samples }; await guard.close(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ status: report.status, steps: report.steps, errors: report.errors, measurements: report.measurements.map(sample => ({ phase: sample.phase, summedRssMiB: sample.treeRssBytes / 1048576 })), output }, null, 2));
process.exitCode = report.status === 'shared-native-host-candidate' ? 0 : 1;
