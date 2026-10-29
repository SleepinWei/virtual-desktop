import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedVisualStages, comparablePair, measureProcesses, siteAction, siteWorkloads } from '../experiments/chromium-engine/site-metrics.js';
import { allowedSiteRequest, externalSites } from '../experiments/chromium-engine/sites.js';

test('a website comparison rejects missing output, changed content and stale native frames', () => {
  const ordinary = { status: 'passed', operations: 8, finalState: { textSha256: 'same', target: { value: 'value' }, scroll: { y: 0 } } };
  const native = { ...ordinary, freshNativeFrames: 8 };
  assert.equal(comparablePair(ordinary, native), true);
  assert.equal(comparablePair(ordinary, { ...native, freshNativeFrames: 7 }), false);
  assert.equal(comparablePair(ordinary, { ...native, finalState: { ...native.finalState, textSha256: 'different' } }), false);
  assert.equal(comparablePair(ordinary, { ...native, finalState: { ...native.finalState, target: { value: 'wrong input' } } }), false);
  assert.equal(comparablePair(ordinary, { ...native, status: 'failed' }), false);
  assert.equal(comparablePair(ordinary, undefined), false);
});
test('CPU samples retain exited descendants and exclude pre-existing process CPU', () => {
  const start = { processes: [{ pid: 1, cpuSeconds: 10 }], treeRssBytes: 100, swapoutBytes: 50, freePercent: 60 };
  const middle = { processes: [{ pid: 1, cpuSeconds: 11 }, { pid: 2, cpuSeconds: 3 }], treeRssBytes: 300, swapoutBytes: 50, freePercent: 55 };
  const end = { processes: [{ pid: 1, cpuSeconds: 12 }], treeRssBytes: 200, swapoutBytes: 70, freePercent: 58 };
  assert.deepEqual(measureProcesses(start, end, [middle]), { processCpuSeconds: 5, peakSummedRssBytes: 300, newHostSwapoutBytes: 20, minHostFreePercent: 55 });
});
test('native visual success alone cannot certify an unmeasured or lower-quality JPEG control', () => {
  const good = { passed: true, controlJpegQuality: { passed: true } };
  assert.equal(acceptedVisualStages([good, good]), true);
  assert.equal(acceptedVisualStages([good]), false);
  assert.equal(acceptedVisualStages([good, { passed: true }]), false);
  assert.equal(acceptedVisualStages([good, { passed: true, controlJpegQuality: { passed: false } }]), false);
});
test('website workloads stay inside configured HTTPS origins and never submit forms or navigate', () => {
  for (const [name, workload] of Object.entries(siteWorkloads)) {
    assert.ok(externalSites[name]);
    assert.equal(allowedSiteRequest(name, externalSites[name].url, { navigation: true }), true);
    for (let i = 0; i < 12; i++) {
      const action = siteAction(workload, i);
      assert.ok(action.type === 'fill' || action.type === 'key' && action.key === 'Tab');
    }
  }
  for (const name of Object.keys(siteWorkloads)) assert.equal(externalSites[name].interactive, name === 'bilibili');
  assert.equal(allowedSiteRequest('python', 'https://ajax.googleapis.com/ajax/libs/jquery.js'), true);
  assert.equal(allowedSiteRequest('python', 'https://ajax.googleapis.com/', { navigation: true }), false);
  assert.equal(allowedSiteRequest('python', 'https://python.org.evil.test/'), false);
});
