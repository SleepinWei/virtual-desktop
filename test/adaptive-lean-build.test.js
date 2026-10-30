import test from 'node:test';
import assert from 'node:assert/strict';
import { reducedBuildJobs, hasRetryHeadroom } from '../experiments/chromium-engine/adaptive-lean-build.js';
import { leanTask } from '../experiments/chromium-engine/lean-task.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const rssStop = { status: 'safety-stopped', safety: { stopped: 'owned-process-rss-limit' } };

test('the combined viewer budget cannot be used for producer smoke or arbitrary native limits', async () => {
  const command = fileURLToPath(new URL('../experiments/chromium-engine/guarded-native-tests.js', import.meta.url));
  for (const [task, limit] of [['smoke', '2048'], ['live', '4096'], ['display', '4096']])
    await assert.rejects(promisify(execFile)(process.execPath, [command, '--task', task, '--root', '/must-not-read',
      '--output', '/must-not-write', '--max-rss-mib', limit]), /Only the combined live producer/);
});

test('public site runs reject unbounded sample counts before touching the filesystem or browser', async () => {
  const command = fileURLToPath(new URL('../experiments/chromium-engine/guarded-native-tests.js', import.meta.url));
  for (const [site, iterations, rounds] of [['example', '13', '1'], ['example', '8', '3'], ['xiaohongshu', '8', '1']])
    await assert.rejects(promisify(execFile)(process.execPath, [command, '--task', 'site', '--site', site, '--root', '/must-not-read',
      '--output', '/must-not-write', '--iterations', iterations, '--rounds', rounds]), /configured --site/);
});

test('site RSS exception requires an explicit live viewer and preserves all other probe budgets', async () => {
  const command = fileURLToPath(new URL('../experiments/chromium-engine/probe-site.js', import.meta.url));
  for (const args of [['--mode', 'ordinary', '--max-rss-mib', '2048'], ['--mode', 'native', '--max-rss-mib', '2048'],
    ['--mode', 'both', '--max-rss-mib', '2048'], ['--mode', 'both', '--viewer', '--max-rss-mib', '4096']])
    await assert.rejects(promisify(execFile)(process.execPath, [command, '--root', '/must-not-read',
      '--output', '/must-not-write', ...args]), /Only an explicit combined live producer/);
});

test('C++ build/run tasks cannot overwrite the candidate executable state', () => {
  assert.notEqual(leanTask('cpp-build').state, leanTask().state);
  assert.equal(leanTask('cpp-build').state, leanTask('cpp-test').state);
  assert.equal(leanTask('cpp-build').phase, 'build');
  assert.equal(leanTask('cpp-test').phase, 'test');
  assert.throws(() => leanTask('../build'), /Unknown/);
});

test('RSS recovery is finite and never increases parallelism', () => {
  const attempts = [8];
  let jobs = 8;
  while ((jobs = reducedBuildJobs(jobs, rssStop)) !== null) attempts.push(jobs);
  assert.deepEqual(attempts, [8, 6, 4, 2, 1]);
  assert.equal(reducedBuildJobs(3, rssStop), 2);
});

test('host pressure, swapping, monitoring failures and user interruption cannot retry', () => {
  for (const reason of ['memory-pressure', 'new-swapouts', 'coordinator-heartbeat-timeout', 'watchdog-exited'])
    assert.equal(reducedBuildJobs(8, { status: 'safety-stopped', safety: { stopped: reason } }), null);
  for (const status of ['interrupted', 'build-failed', 'compiled-candidate'])
    assert.equal(reducedBuildJobs(8, { ...rssStop, status }), null);
});

test('RSS retry requires sustained headroom and no new swapping', () => {
  const samples = [{ time: 0, freePercent: 70, swapoutBytes: 100 },
    { time: 5000, freePercent: 65, swapoutBytes: 100 }, { time: 10000, freePercent: 60, swapoutBytes: 100 }];
  assert.equal(hasRetryHeadroom(samples), true);
  assert.equal(hasRetryHeadroom([]), false);
  assert.equal(hasRetryHeadroom(samples.slice(0, 2)), false);
  assert.equal(hasRetryHeadroom(samples.map((sample, i) => ({ ...sample, freePercent: i === 1 ? 44 : 70 }))), false);
  assert.equal(hasRetryHeadroom(samples.map((sample, i) => ({ ...sample, swapoutBytes: 100 + i }))), false);
});
