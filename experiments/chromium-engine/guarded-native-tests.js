import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startLoadGuard, terminateProcessTree } from './load-guard.js';
import { browserProcessArgs } from './browser-runtime.js';
import { siteWorkloads } from './site-metrics.js';
import { cleanupNativeDirectories } from './native-stream.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, task: { type: 'string' },
  canvaskit: { type: 'string' }, output: { type: 'string' }, 'in-process-gpu': { type: 'boolean', default: false },
  'max-rss-mib': { type: 'string', default: '1536' }, site: { type: 'string' },
  iterations: { type: 'string', default: '8' }, rounds: { type: 'string', default: '2' } } });
const tasks = {
  smoke: ['smoke-runtime.js', 'smoke-report.json', 'native-runtime-smoke-passed'],
  frames: ['run-frames.js', 'frame-engine-report.json', 'native-frame-candidate'],
  live: ['run-live.js', 'live-report.json', 'live-native-session-candidate'],
  urls: ['verify-urls.js', 'url-report.json', 'native-url-preview-candidate'],
  engine: ['run.js', 'engine-report.json', 'record-only-display-candidate'],
  pool: ['probe-pool.js', 'pool-report.json', 'shared-native-host-candidate'],
  site: ['compare-site.js', 'site-report.json', 'public-site-comparison-complete'],
  fonts: ['diagnose-fonts.js', 'diagnostic-report.json', 'native-diagnostics-complete'],
  images: ['diagnose-fonts.js', 'diagnostic-report.json', 'native-diagnostics-complete'],
  'raster-diagnostic': ['diagnose-native.js', 'diagnostic-report.json', 'native-diagnostics-complete'],
  'startup-diagnostic': ['diagnose-native.js', 'diagnostic-report.json', 'native-diagnostics-complete'],
};
if (!values.root || !values.output || !Object.hasOwn(tasks, values.task)) throw new Error('Pass --root, --output and a configured --task');
if (values.task === 'site' && (!Object.hasOwn(siteWorkloads, values.site) || !Number.isInteger(Number(values.iterations)) ||
    Number(values.iterations) < 4 || Number(values.iterations) > 12 || ![1, 2].includes(Number(values.rounds))))
  throw new Error('Site tests require a configured --site, --iterations 4..12 and --rounds 1..2');
const maxRssMiB = Number(values['max-rss-mib']);
if (maxRssMiB !== 1536 && !(['live', 'urls'].includes(values.task) && maxRssMiB === 2048))
  throw new Error('Only the combined live producer/viewer tests (live or urls) may use 2048 MiB; other native tests require 1536 MiB');
const root = resolve(values.root), output = resolve(values.output), [script, resultName, expected] = tasks[values.task];
const gpuProcessMode = values['in-process-gpu'] ? 'in-process' : 'separate';
browserProcessArgs({ mode: gpuProcessMode });
await mkdir(output, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), task: values.task, root, status: 'initializing',
  ...(values.task === 'site' ? { site: values.site, iterations: Number(values.iterations), rounds: Number(values.rounds) } : {}),
  engineSplitGate: 'not-passed', serverRasterBypassed: false, errors: [], gpuProcessMode, maxRssMiB,
  cpuPolicy: { nice: 10, qosClamp: null, diskThrottle: false,
    scope: 'Keep Chromium rendering/trace thread QoS and IO scheduling; reduce CPU process priority and retain the default resource watchdog.' },
  scope: 'Sequential fixture or allowlisted public-site tests. Default 1.5 GiB RSS; only an explicit combined live producer/viewer run (live or urls) may use 2 GiB. Host pressure/swap/heartbeat/time limits remain enforced.' };
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
  if (values.task === 'images') args.push('--images');
  if (values.task === 'startup-diagnostic') args.push('--startup');
  if (values.task === 'site') args.push('--site', values.site, '--iterations', values.iterations, '--rounds', values.rounds);
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
  if (child?.pid) {
    try { report.cleanedNativeDirectories = await cleanupNativeDirectories([child.pid,
      ...(guard?.samples || []).flatMap(sample => sample.processes.map(row => row.pid))]); }
    catch (error) { report.errors.push('Native temporary directory cleanup failed: ' + error.code); }
  }
  if (report.interrupted) report.status = 'interrupted';
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'guard-report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, task: report.task, testStatus: report.testStatus, errors: report.errors, output }, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
