import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostSample } from './load-guard.js';

export function reducedBuildJobs(jobs, report) {
  if (report.status !== 'safety-stopped' || report.safety?.stopped !== 'owned-process-rss-limit') return null;
  return [8, 6, 4, 2, 1].find(value => value < jobs) ?? null;
}

export function hasRetryHeadroom(samples) {
  if (samples.length < 2 || samples.at(-1).time - samples[0].time < 10000) return false;
  return samples.every(sample => sample.freePercent >= 45)
    && samples.at(-1).swapoutBytes === samples[0].swapoutBytes;
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
    output: { type: 'string', default: 'test-results/lean-adaptive' }, jobs: { type: 'string', default: '8' },
    'max-rss-mib': { type: 'string', default: '6144' } } });
  let jobs = Number(values.jobs);
  const maxRssMiB = Number(values['max-rss-mib']);
  if (!values.root || !Number.isInteger(jobs) || jobs < 1 || jobs > 8
    || !Number.isSafeInteger(maxRssMiB) || maxRssMiB < 512 || maxRssMiB > 8192) throw new Error('Use --root, --jobs 1..8, --max-rss-mib 512..8192');
  const root = resolve(values.root), output = resolve(values.output);
  await mkdir(output, { recursive: true });
  const report = { version: 1, startedAt: new Date().toISOString(), status: 'initializing', root, maxJobs: jobs,
    maxRssMiB, attempts: [], engineSplitGate: 'not-passed',
    policy: 'Only owned RSS stops can reduce jobs. Require 10 seconds of free>=45% and zero swapouts within a 60-second wait; never raise jobs or retry at one job. Host-pressure, swapping, heartbeat, tool failures and user interrupts stop immediately.' };
  const save = async () => {
    await writeFile(join(output, 'supervisor-report.json.tmp'), JSON.stringify(report, null, 2) + '\n');
    await rename(join(output, 'supervisor-report.json.tmp'), join(output, 'supervisor-report.json'));
  };
  let child, interrupted = false;
  const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!interrupted) {
      const attemptOutput = join(output, `attempt-${report.attempts.length + 1}-jobs-${jobs}`);
      const attempt = { jobs, output: attemptOutput, startedAt: new Date().toISOString(), status: 'running' };
      report.attempts.push(attempt); report.status = 'running'; report.currentJobs = jobs;
      report.guardReport = join(attemptOutput, 'guard-report.json'); await save();
      if (interrupted) break;
      child = spawn(process.execPath, [fileURLToPath(new URL('./guarded-lean-build.js', import.meta.url)),
        '--root', root, '--jobs', String(jobs), '--max-rss-mib', String(maxRssMiB), '--output', attemptOutput],
      { stdio: ['ignore', 'inherit', 'inherit'] });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      child = null;
      const guardReport = JSON.parse(await readFile(report.guardReport, 'utf8'));
      if (!guardReport.finishedAt || !['compiled-candidate', 'safety-stopped', 'interrupted', 'build-failed'].includes(guardReport.status))
        throw new Error('Guard exited without a final report; refusing to retry');
      Object.assign(attempt, { status: guardReport.status, reason: guardReport.safety?.stopped ?? null,
        finishedAt: guardReport.finishedAt });
      report.status = interrupted ? 'interrupted' : guardReport.status;
      const next = interrupted ? null : reducedBuildJobs(jobs, guardReport);
      if (next === null) break;
      report.status = 'waiting-for-headroom'; report.nextJobs = next; await save();
      const samples = [], deadline = Date.now() + 60000;
      let ready = false;
      while (!interrupted && Date.now() < deadline) {
        samples.push(await hostSample([process.pid]));
        while (samples.length > 1 && samples.at(-1).time - samples[0].time > 12000) samples.shift();
        if (hasRetryHeadroom(samples)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      report.retryHeadroom = samples.map(({ time, freePercent, swapoutBytes }) => ({ time, freePercent, swapoutBytes }));
      if (!ready) { report.status = interrupted ? 'interrupted' : 'safety-stopped'; break; }
      jobs = next; delete report.nextJobs;
    }
  } catch (error) {
    report.status = 'supervisor-failed'; report.error = error.message;
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    if (interrupted) report.status = 'interrupted';
    report.finishedAt = new Date().toISOString(); await save();
  }
  console.log(JSON.stringify({ status: report.status, attempts: report.attempts, output }, null, 2));
  process.exitCode = report.status === 'compiled-candidate' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
