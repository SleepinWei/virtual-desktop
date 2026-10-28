import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { availableParallelism, loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
export const SAFE_LIMITS = { minFreePercent: 35, maxSwapoutBytes: 64 * 1024 ** 2,
  maxTreeRssBytes: 1536 * 1024 ** 2, maxHeartbeatMs: 4000, maxDurationMs: 180000 };
export function guardLimits({ maxTreeRssBytes = SAFE_LIMITS.maxTreeRssBytes } = {}) {
  if (!Number.isSafeInteger(maxTreeRssBytes) || maxTreeRssBytes <= 0) throw new Error('Invalid owned RSS budget');
  return { ...SAFE_LIMITS, maxTreeRssBytes };
}
export function pressureReason(sample, baseline, limits = SAFE_LIMITS, { enforceSystemLoad = true } = {}) {
  if (sample.freePercent < limits.minFreePercent) return 'memory-pressure';
  if (sample.swapoutBytes - baseline.swapoutBytes > limits.maxSwapoutBytes) return 'new-swapouts';
  if (sample.treeRssBytes > limits.maxTreeRssBytes) return 'owned-process-rss-limit';
  if (enforceSystemLoad && sample.load > availableParallelism() * .8) return 'system-load';
  return null;
}
function seconds(text) {
  const parts = text.split(':').map(Number); let total = 0;
  for (const part of parts) total = total * 60 + part;
  return total;
}
async function processRows() {
  const { stdout: ps } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time='], { timeout: 2000 });
  return ps.trim().split('\n').map(line => {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, cpuSeconds: seconds(cpu) };
  });
}
export function selectProcessTree(all, roots) {
  const ids = new Set(roots);
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size;
    for (const row of all) if (ids.has(row.ppid)) ids.add(row.pid);
  }
  return all.filter(row => ids.has(row.pid));
}
export function processTerminationOrder(all, roots) {
  const owned = selectProcessTree(all, roots), parents = new Map(owned.map(row => [row.pid, row])), depths = new Map();
  const depth = row => {
    if (!depths.has(row.pid)) depths.set(row.pid, parents.has(row.ppid) ? depth(parents.get(row.ppid)) + 1 : 0);
    return depths.get(row.pid);
  };
  return owned.sort((a, b) => depth(b) - depth(a));
}
export async function terminateProcessTree(roots, fallback = []) {
  const all = await processRows().catch(() => fallback);
  const owned = processTerminationOrder(all, roots);
  // Ninja compiler children can have their own process groups. Kill the
  // captured descendants before the root, rather than just its process group.
  for (const row of owned) { try { process.kill(row.pid, 'SIGKILL'); } catch {} }
  for (const pid of roots) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
export async function hostSample(roots) {
  const [all, { stdout: pressure }, { stdout: vm }] = await Promise.all([
    processRows(),
    exec('/usr/bin/memory_pressure', ['-Q'], { timeout: 2000 }),
    exec('/usr/bin/vm_stat', [], { timeout: 2000 }),
  ]);
  const processes = selectProcessTree(all, roots);
  const freePercent = Number(/free percentage:\s*(\d+)%/.exec(pressure)?.[1]);
  const pageSize = Number(/page size of (\d+)/.exec(vm)?.[1]), swapouts = Number(/Swapouts:\s*(\d+)/.exec(vm)?.[1]);
  if (![freePercent, pageSize, swapouts].every(Number.isFinite)) throw new Error('Cannot read host safety telemetry');
  return { time: Date.now(), freePercent, swapoutBytes: swapouts * pageSize, load: loadavg()[0], processes,
    treeRssBytes: processes.reduce((sum, row) => sum + row.rss, 0) };
}

// Out-of-process watchdog remains responsive if the benchmark coordinator stalls.
export async function startLoadGuard({ persistent = false, enforceSystemLoad = true, maxTreeRssBytes, onStop } = {}) {
  if (process.platform !== 'darwin') throw new Error('This host safety implementation currently supports macOS only');
  const limits = guardLimits({ maxTreeRssBytes });
  const baseline = await hostSample([process.pid]);
  const reason = pressureReason(baseline, baseline, limits, { enforceSystemLoad });
  if (reason) throw new Error('Host preflight stopped: ' + reason);
  const child = fork(new URL('./load-guard.js', import.meta.url), ['--watch'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  child.stderr.resume();
  const samples = [], targets = new Set(); let stopped = null, closed = false;
  const ready = new Promise((resolve, reject) => { child.once('error', reject); child.once('message', resolve);
    child.once('exit', () => reject(new Error('Safety watchdog exited before initialization'))); });
  const send = message => { if (child.connected) child.send(message, error => { if (error && !closed) stopped ||= 'watchdog-unavailable'; }); };
  child.on('message', message => {
    if (message.sample) { samples.push(message.sample); if (samples.length > 256) samples.shift(); }
    if (message.stop) { stopped = message.stop; onStop?.({ reason: stopped, sample: message.sample }); }
  });
  child.on('exit', () => { if (!closed) stopped ||= 'watchdog-exited'; });
  child.on('error', () => { if (!closed) stopped ||= 'watchdog-unavailable'; });
  send({ parentPid: process.pid, targets: [], baseline, persistent, enforceSystemLoad, maxTreeRssBytes: limits.maxTreeRssBytes }); await ready;
  const heartbeat = setInterval(() => send({ heartbeat: true }), 500); heartbeat.unref();
  return { baseline, samples, policy: { ...limits, maxDurationMs: persistent ? null : limits.maxDurationMs,
    enforceSystemLoad, systemLoadStopAbove: enforceSystemLoad ? availableParallelism() * .8 : null }, get stopped() { return stopped; },
    add(pid) { targets.add(pid); send({ targets: [...targets] }); },
    remove(pid) { targets.delete(pid); send({ targets: [...targets] }); },
    check() { if (stopped) throw new Error('Safety stop: ' + stopped); },
    async close() { closed = true; clearInterval(heartbeat); send({ close: true });
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--watch') {
  let parentPid, targets = [], baseline, heartbeat = Date.now(), sampling = false, finished = false, persistent = false, enforceSystemLoad = true;
  let limits = guardLimits(), lastSample;
  const started = Date.now(), recent = [];
  async function stop(reason, sample) {
    if (finished) return; finished = true;
    // Only kill descendants of explicitly registered benchmark workers.
    await terminateProcessTree(targets, (sample || lastSample)?.processes);
    if (process.connected) process.send({ stop: reason, sample });
  }
  process.on('message', message => {
    if (message.close) process.exit(0);
    if (message.parentPid) { parentPid = message.parentPid; baseline = message.baseline; persistent = message.persistent === true;
      enforceSystemLoad = message.enforceSystemLoad !== false; limits = guardLimits(message); process.send({ ready: true }); }
    if (message.targets) targets = message.targets;
    if (message.heartbeat) heartbeat = Date.now();
  });
  process.on('disconnect', () => { stop('coordinator-disconnected').finally(() => process.exit(1)); });
  setInterval(async () => {
    if (!parentPid || sampling || finished) return; sampling = true;
    try {
      const sample = await hostSample([parentPid]); lastSample = sample;
      recent.push(sample);
      while (recent.length > 1 && sample.time - recent[0].time > 10000) recent.shift();
      const reason = Date.now() - heartbeat > SAFE_LIMITS.maxHeartbeatMs ? 'coordinator-heartbeat-timeout'
        : !persistent && Date.now() - started > SAFE_LIMITS.maxDurationMs ? 'wall-time-limit'
          : pressureReason(sample, persistent ? recent[0] : baseline, limits, { enforceSystemLoad });
      if (reason) await stop(reason, sample); else if (process.connected) process.send({ sample });
    } catch { await stop('safety-telemetry-unavailable'); }
    finally { sampling = false; }
  }, 1000);
}
