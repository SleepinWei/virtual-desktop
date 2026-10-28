import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFile, mkdir, open, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLoadGuard } from './load-guard.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  output: { type: 'string', default: 'test-results/lean-build' } } });
if (!values.root) throw new Error('Pass --root for the external APFS build root');
const root = resolve(values.root), output = resolve(values.output);
await mkdir(output, { recursive: true });
const statePath = join(root, 'chromium/virtual-desktop-lean-ninja-build-state.json');
const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', root, jobs: 1, builder: 'ninja',
  cpuPolicy: { jobs: 1, nice: 19, darwinBackground: true, qosClamp: 'background', systemLoadHardStop: false,
    scope: 'Compiler subtree only; the coordinator/watchdog run outside its background QoS clamp.' },
  engineSplitGate: 'not-passed', errors: [], scope: 'Separate non-component candidate. Does not replace the working runtime or imply C++/native/visual acceptance.' };
let guard, child, log;
let saveChain = Promise.resolve();
const save = () => {
  const data = JSON.stringify(report, null, 2) + '\n';
  const result = saveChain.then(async () => {
    await writeFile(join(output, 'guard-report.json.tmp'), data);
    await rename(join(output, 'guard-report.json.tmp'), join(output, 'guard-report.json'));
  });
  saveChain = result.catch(() => {}); return result;
};
try {
  guard = await startLoadGuard({ persistent: true, enforceSystemLoad: false });
  log = await open(join(output, 'coordinator.log'), 'a');
  guard.check();
  child = spawn('/usr/sbin/taskpolicy', ['-b', '-c', 'background', '/usr/bin/nice', '-n', '19', 'python3',
    '-B', fileURLToPath(new URL('./lean-build.py', import.meta.url)), 'build', '--root', root],
    { stdio: ['ignore', log.fd, log.fd], detached: true });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  completion.catch(() => {});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  if (!child.pid) throw new Error('Could not spawn lean build');
  guard.add(child.pid); report.childPid = child.pid; report.status = 'running'; await save();
  const cleanup = () => { report.stopRequested = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  let lastSnapshot = 0;
  const snapshot = setInterval(() => {
    // A watchdog exit is also a stop: never leave an unmonitored compiler alive.
    if (guard.stopped) cleanup();
    if (Date.now() - lastSnapshot >= 5000) {
      lastSnapshot = Date.now(); report.safety = { stopped: guard.stopped, policy: guard.policy, baseline: guard.baseline, samples: guard.samples };
      save().catch(() => {});
    }
  }, 1000);
  snapshot.unref();
  process.once('SIGTERM', cleanup); process.once('SIGINT', cleanup);
  try {
    const result = await completion;
    report.result = result; report.status = guard.stopped ? 'safety-stopped' : report.stopRequested ? 'interrupted' : result.code === 0 ? 'compiled-candidate' : 'build-failed';
  } finally { clearInterval(snapshot); process.off('SIGTERM', cleanup); process.off('SIGINT', cleanup); }
} catch (error) { report.errors.push(error.message); report.status = guard?.stopped ? 'safety-stopped' : 'build-failed'; }
finally {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await log?.close();
  if (guard) {
    report.safety = { stopped: guard.stopped, policy: guard.policy, baseline: guard.baseline, samples: guard.samples };
    if (guard.stopped || report.stopRequested) {
      if (guard.stopped) report.status = 'safety-stopped';
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        const temporary = statePath + '.guard.tmp';
        await writeFile(temporary, JSON.stringify({ ...state, stage: report.status, compiled: false, pid: null,
          safetyStop: guard.stopped, exitCode: null, finishedUnix: Date.now() / 1000,
          updatedAt: new Date().toISOString() }, null, 2) + '\n');
        await rename(temporary, statePath);
      } catch (error) { report.errors.push('Could not record stopped candidate state: ' + error.message); }
    }
    await guard.close();
  }
  report.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ status: report.status, result: report.result, errors: report.errors, output }, null, 2));
process.exitCode = report.status === 'compiled-candidate' ? 0 : 1;
