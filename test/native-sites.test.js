import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedSiteRequest } from '../experiments/chromium-engine/sites.js';
import { pressureReason, SAFE_LIMITS } from '../experiments/chromium-engine/load-guard.js';

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
