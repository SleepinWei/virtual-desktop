import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startLoadGuard, terminateProcessTree } from './load-guard.js';
import { browserProcessArgs } from './browser-runtime.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, task: { type: 'string' },
  canvaskit: { type: 'string' }, output: { type: 'string' }, 'in-process-gpu': { type: 'boolean', default: false },
  'max-rss-mib': { type: 'string', default: '1536' } } });
const tasks = {
  smoke: ['smoke-runtime.js', 'smoke-report.json', 'native-runtime-smoke-passed'],
  frames: ['run-frames.js', 'frame-engine-report.json', 'native-frame-candidate'],
  live: ['run-live.js', 'live-report.json', 'live-native-session-candidate'],
  engine: ['run.js', 'engine-report.json', 'record-only-display-candidate'],
  pool: ['probe-pool.js', 'pool-report.json', 'shared-native-host-candidate'],
};
if (!values.root || !values.output || !Object.hasOwn(tasks, values.task)) throw new Error('Pass --root, --output, --task smoke|frames|live|engine|pool');
const maxRssMiB = Number(values['max-rss-mib']);
if (maxRssMiB !== 1536 && !(values.task === 'live' && maxRssMiB === 2048))
  throw new Error('Only the combined live producer/viewer test may use 2048 MiB; other native tests require 1536 MiB');
const root = resolve(values.root), output = resolve(values.output), [script, resultName, expected] = tasks[values.task];
const gpuProcessMode = values['in-process-gpu'] ? 'in-process' : 'separate';
browserProcessArgs({ mode: gpuProcessMode });
await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), task: values.task, root, status: 'initializing',
  engineSplitGate: 'not-passed', serverRasterBypassed: false, errors: [], gpuProcessMode, maxRssMiB,
  cpuPolicy: { nice: 10, qosClamp: null, diskThrottle: false,
    scope: 'Keep Chromium rendering/trace thread QoS and IO scheduling; reduce CPU process priority and retain the default resource watchdog.' },
  scope: 'Sequential trusted tests. Default 1.5 GiB RSS; only an explicit combined live producer/viewer run may use 2 GiB. Host pressure/swap/heartbeat/time limits remain enforced.' };
let guard, child, log, interval, ended = false, termination;
const stop = () => termination ||= terminateProcessTree([child.pid], guard.samples.at(-1)?.processes);
const signal = () => { report.interrupted = true; if (child?.pid && !ended) stop(); };
try {
  guard = await startLoadGuard({ maxTreeRssBytes: maxRssMiB * 1024 ** 2 });
  log = await open(join(output, 'coordinator.log'), 'a');
  await rm(join(output, resultName), { force: true });
  const args = ['--root', root, '--output', output];
  if (values.task !== 'smoke') args.push('--canvaskit', resolve(values.canvaskit || join(root, 'canvaskit/out')));
  if (values.task === 'live') args.push('--single-session');
  child = spawn('/usr/bin/nice', ['-n', '10',
    process.execPath, fileURLToPath(new URL('./' + script, import.meta.url)), ...args], { detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, VIRTUAL_DESKTOP_MAC_GPU_MODE: gpuProcessMode } });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }); }); });
  completion.catch(() => {});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  guard.add(child.pid); report.childPid = child.pid; report.status = 'running';
  await writeFile(join(output, 'guard-report.json'), JSON.stringify(report, null, 2));
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  interval = setInterval(() => { if (guard.stopped && !ended) stop(); }, 500);
  report.result = await completion;
  const result = JSON.parse(await readFile(join(output, resultName), 'utf8'));
  report.testStatus = result.status;
  report.status = report.result.code === 0 && result.status === expected ? 'passed' : 'test-failed';
} catch (error) { report.errors.push(error.message); report.status = 'test-failed'; }
finally {
  clearInterval(interval); process.off('SIGTERM', signal); process.off('SIGINT', signal);
  if (child?.pid) {
    if (!ended) await stop();
    if (termination) await termination;
    guard?.remove(child.pid);
  }
  await log?.close();
  if (guard) {
    report.safety = { stopped: guard.stopped, policy: guard.policy, baseline: guard.baseline, samples: guard.samples };
    if (guard.stopped) report.status = 'safety-stopped';
    await guard.close();
  }
  if (report.interrupted) report.status = 'interrupted';
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'guard-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, task: report.task, testStatus: report.testStatus, errors: report.errors, output }, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
