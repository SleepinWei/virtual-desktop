import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedSiteRequest } from '../experiments/chromium-engine/sites.js';
import { pressureReason, SAFE_LIMITS, guardLimits, selectProcessTree, processTerminationOrder } from '../experiments/chromium-engine/load-guard.js';

test('external preview restricts navigation and resources to the configured HTTPS domains', () => {
  assert.equal(allowedSiteRequest('xiaohongshu', 'https://www.xiaohongshu.com/explore', { navigation: true }), true);
  assert.equal(allowedSiteRequest('xiaohongshu', 'https://sns-img.xhscdn.com/a.jpg'), true);
  for (const url of ['http://www.xiaohongshu.com/', 'https://xiaohongshu.com.evil.test/', 'https://127.0.0.1/', 'file:///etc/passwd',
    'https://user:secret@www.xiaohongshu.com/', 'https://www.xiaohongshu.com:8443/']) assert.equal(allowedSiteRequest('xiaohongshu', url), false);
  assert.equal(allowedSiteRequest('xiaohongshu', 'https://sns-img.xhscdn.com/a', { navigation: true }), false);
  assert.equal(allowedSiteRequest('unknown', 'https://www.xiaohongshu.com/'), false);
  assert.equal(allowedSiteRequest('bilibili', 'https://www.bilibili.com/', { navigation: true }), true);
  assert.equal(allowedSiteRequest('bilibili', 'https://i0.hdslb.com/a.webp'), true);
  assert.equal(allowedSiteRequest('bilibili', 'https://i0.hdslb.com/', { navigation: true }), false);
  assert.equal(allowedSiteRequest('bilibili', 'https://bilibili.com.evil.test/'), false);
  assert.equal(allowedSiteRequest('bilibili', 'https://api.bilibili.com/a', { method: 'DELETE' }), false);
});
test('load safety stops on new swapping, low memory or the owned RSS budget', () => {
  const baseline = { freePercent: 50, swapoutBytes: 100, treeRssBytes: 100, load: 0 };
  assert.equal(pressureReason(baseline, baseline), null);
  assert.equal(pressureReason({ ...baseline, freePercent: 34 }, baseline), 'memory-pressure');
  assert.equal(pressureReason({ ...baseline, swapoutBytes: 101 + SAFE_LIMITS.maxSwapoutBytes }, baseline), 'new-swapouts');
  assert.equal(pressureReason({ ...baseline, treeRssBytes: SAFE_LIMITS.maxTreeRssBytes + 1 }, baseline), 'owned-process-rss-limit');
});
test('background compilation can ignore aggregate CPU load while memory and swap protection remain enforced', () => {
  const baseline = { freePercent: 50, swapoutBytes: 100, treeRssBytes: 100, load: 0 };
  const busy = { ...baseline, load: Number.MAX_SAFE_INTEGER };
  const background = { enforceSystemLoad: false };
  assert.equal(pressureReason(busy, baseline), 'system-load');
  assert.equal(pressureReason(busy, baseline, SAFE_LIMITS, background), null);
  assert.equal(pressureReason({ ...busy, freePercent: 34 }, baseline, SAFE_LIMITS, background), 'memory-pressure');
  assert.equal(pressureReason({ ...busy, treeRssBytes: SAFE_LIMITS.maxTreeRssBytes + 1 }, baseline, SAFE_LIMITS, background), 'owned-process-rss-limit');
  assert.equal(pressureReason({ ...busy, swapoutBytes: 101 + SAFE_LIMITS.maxSwapoutBytes }, baseline, SAFE_LIMITS, background), 'new-swapouts');
});
test('a larger compiler RSS budget preserves host protection and leaves browser defaults unchanged', () => {
  const limits = guardLimits({ maxTreeRssBytes: 6 * 1024 ** 3 });
  const baseline = { freePercent: 50, swapoutBytes: 100, treeRssBytes: 2 * 1024 ** 3, load: 0 };
  assert.equal(pressureReason(baseline, baseline, limits), null);
  assert.equal(pressureReason(baseline, baseline), 'owned-process-rss-limit');
  assert.equal(pressureReason({ ...baseline, freePercent: 34 }, baseline, limits), 'memory-pressure');
  assert.equal(pressureReason({ ...baseline, swapoutBytes: 101 + SAFE_LIMITS.maxSwapoutBytes }, baseline, limits), 'new-swapouts');
  assert.equal(guardLimits().maxTreeRssBytes, 1536 * 1024 ** 2);
  for (const invalid of [0, -1, NaN, Infinity]) assert.throws(() => guardLimits({ maxTreeRssBytes: invalid }), /RSS budget/);
});
test('owned-process selection includes detached compiler groups and excludes user processes', () => {
  const all = [{ pid: 10, ppid: 1, pgid: 10 }, { pid: 30, ppid: 20, pgid: 30 },
    { pid: 40, ppid: 30, pgid: 40 }, { pid: 50, ppid: 10, pgid: 50 }, { pid: 20, ppid: 10, pgid: 20 }];
  assert.deepEqual(selectProcessTree(all, [20]).map(row => row.pid).sort(), [20, 30, 40]);
  assert.deepEqual(processTerminationOrder(all, [20]).map(row => row.pid), [40, 30, 20]);
  const wrapped = [{ pid: 90000, ppid: 1 }, { pid: 100, ppid: 90000 }, { pid: 80, ppid: 100 }];
  assert.deepEqual(processTerminationOrder(wrapped, [90000]).map(row => row.pid), [80, 100, 90000]);
});
