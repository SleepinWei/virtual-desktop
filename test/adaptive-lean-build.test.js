import test from 'node:test';
import assert from 'node:assert/strict';
import { reducedBuildJobs, hasRetryHeadroom } from '../experiments/chromium-engine/adaptive-lean-build.js';

const rssStop = { status: 'safety-stopped', safety: { stopped: 'owned-process-rss-limit' } };

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
