import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '../../src/server.js';
import { AgentClient } from '../../src/client.js';
import { verifiedEngine } from './verified.js';
import { startLoadGuard } from './load-guard.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string', default: 'test-results/runtime-smoke' } } });
if (!values.root) throw new Error('Pass --root pointing to the extracted runtime');
const root = resolve(values.root), output = resolve(values.output);
await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', steps: [], errors: [],
  scope: 'One local native producer and real DOM/input check from extracted bytes. No viewer, visual comparison or external-site pass.',
  engineSplitGate: 'not-passed', serverRasterBypassed: false };
let guard, service, temporary;
const check = (condition, message) => { if (!condition) throw new Error(message); };
try {
  guard = await startLoadGuard();
  const engine = await verifiedEngine(root, { requireStream: true });
  report.build = { revision: engine.source.revision, patchSha256: engine.patchSha256, artifactsSha256: engine.artifactsSha256,
    distributionFormat: engine.state.distributionFormat };
  temporary = await mkdtemp(join(tmpdir(), 'vd-runtime-smoke-'));
  service = createService({ dataDir: temporary, adminToken: 'runtime-smoke', maxActive: 1,
    onWorker(worker) { guard.add(worker.child.pid); worker.exited.then(() => guard.remove(worker.child.pid)); },
    chromium: { root, canvasKitDirectory: join(root, 'canvaskit/out'), maxSessions: 1 } });
  const base = await service.listen(0);
  const response = await fetch(base + '/api/sessions', { method: 'POST', signal: AbortSignal.timeout(35000),
    headers: { Authorization: 'Bearer runtime-smoke', 'Content-Type': 'application/json' }, body: '{"backend":"chromium","fixture":"live"}' });
  const session = await response.json();
  report.native = { status: response.status, error: session.error || null,
    sessions: [...service.manager.sessions.values()].map(state => ({ state: state.state, frames: state.frames?.stats, workerDiagnostics: state.worker?.diagnostics })) };
  guard.check();
  check(response.status === 201, 'Native init failed: ' + JSON.stringify(session));
  report.steps.push('Verified engine/CanvasKit checksums and started a native session from the configured runtime root');
  const agent = new AgentClient(base, session);
  await agent.fill('#message', 'Runtime subset 42');
  const first = await agent.action({ type: 'click', selector: '#increment' }, 'subset-increment');
  const again = await agent.action({ type: 'click', selector: '#increment' }, 'subset-increment');
  check(!first.deduplicated && again.deduplicated, 'Native action deduplication failed');
  const observation = await agent.observe();
  check(/Increment\s+1/.test(observation.text) && observation.targets.some(target => target.selector === '#message' && target.value === 'Runtime subset 42'),
    'Real DOM did not retain the typed value and single increment');
  const internal = service.manager.get(session.id);
  report.frames = internal.frames.stats;
  check(report.frames.received > 0 && report.frames.resourceBytes > 0 && !report.frames.fault, 'No supported native resources');
  report.metrics = await internal.worker.call('metrics');
  report.steps.push('Real input, click and duplicate fencing passed; complete native frames/resources arrived over the socket');
  guard.check(); report.status = 'native-runtime-smoke-passed';
} catch (error) { report.errors.push(error.message); report.status = guard?.stopped ? 'safety-stopped' : 'smoke-failed'; }
finally {
  await service?.close().catch(() => {});
  if (guard) {
    if (guard.stopped) report.status = 'safety-stopped';
    report.safety = { stopped: guard.stopped, baseline: guard.baseline, samples: guard.samples }; await guard.close();
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, steps: report.steps, errors: report.errors, output }, null, 2));
process.exitCode = report.status === 'native-runtime-smoke-passed' ? 0 : 1;
