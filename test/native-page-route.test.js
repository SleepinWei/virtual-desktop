import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePageRoute } from '../experiments/chromium-engine/page-route.js';
import { ChromiumSession } from '../experiments/chromium-engine/session.js';

const url = 'https://info.cern.ch/page';
const cat = 'disabled-by-default-devtools.timeline';
const commit = (pid, frame, ts, address = url) => ({ name: 'FrameCommittedInBrowser', cat, pid: 10, ts, args: { data: { url: address, frame, processId: pid } } });
const tree = (pid, frame, treeId, ts) => ({ name: 'SetLayerTreeId', cat, pid, ts, args: { data: { frame, layerTreeId: treeId } } });
const ready = (pid, frame, ts) => ({ name: 'ProcessReadyInBrowser', cat, pid: 10, ts, args: { data: { frame, processId: pid } } });

test('main widget binding excludes an old blank widget, child frame, pending PID and previous renderer', () => {
  const events = [commit(-1, 'main', 0), commit(20, 'main', 1), tree(20, 'main', 1, 2),
    commit(21, 'main', 3), tree(21, 'main', 1, 2), tree(21, 'main', 2, 4),
    commit(22, 'child', 5), tree(22, 'child', 9, 6), tree(21, 'child', 8, 7)];
  const result = nativePageRoute(events, url, 'main');
  assert.deepEqual(result.route, { pid: 21, treeId: 2 });
  assert.deepEqual(result.retiredTreeIds, [1]);
  assert.deepEqual(result.rendererPids, [21]);
});
test('widget binding rejects absent, pre-commit or ambiguous identities instead of guessing from native delivery order', () => {
  for (const events of [[commit(21, 'main', 3)], [commit(21, 'main', 3), tree(21, 'main', 1, 2)],
    [commit(21, 'main', 1), tree(21, 'main', 1, 2), tree(21, 'main', 2, 2)],
    [commit(21, 'main', 1), tree(21, 'other', 2, 2)], [commit(21, 'main', 1, 'https://other.test/'), tree(21, 'main', 2, 2)],
    [commit(21, 'main', 1), commit(22, 'main', 1), tree(21, 'main', 2, 2)]])
    assert.throws(() => nativePageRoute(events, url, 'main'), /provenance/);
});
test('only widgets proven retired at startup may be ignored; a new widget still stops presentation', () => {
  const faults = [], session = new ChromiumSession({ onFrame() {}, onBrowser() {}, onFault(message) { faults.push(message); } });
  session.route = { pid: 21, treeId: 2 }; session.retiredStartupTrees = new Set([1]);
  session.receive({ pid: 21, snapshot: { tree_id: 1 } });
  assert.equal(faults.length, 0); assert.equal(session.excluded, 1);
  session.receive({ pid: 21, snapshot: { tree_id: 3 } });
  assert.equal(faults.length, 1); assert.match(faults[0], /Additional native widget/);
});
test('a commit without processId consumes the same-frame browser process-ready event', () => {
  const events = [tree(20, 'main', 1, 1), commit(undefined, 'main', 2), tree(20, 'main', 1, 3), ready(21, 'main', 3), tree(21, 'main', 1, 4), tree(22, 'child', 2, 5)];
  const result = nativePageRoute(events, url, 'main', { browserPid: 10 });
  assert.deepEqual(result.route, { pid: 21, treeId: 1 });
  assert.equal(result.evidence[0].browserEventProcessId, null);
  assert.equal(result.evidence[0].processIdSource, 'browser-process-ready');
  assert.throws(() => nativePageRoute([...events, ready(20, 'main', 4)], url, 'main'), /ambiguous/);
  assert.throws(() => nativePageRoute(events.filter(item => item.name !== 'ProcessReadyInBrowser'), url, 'main'), /readiness/);
  assert.throws(() => nativePageRoute(events.map(item => item.name === 'ProcessReadyInBrowser' ? { ...item, cat: 'blink.user_timing' } : item), url, 'main'), /readiness/);
});
test('user timing, a wrong browser process or a pre-commit widget cannot manufacture provenance', () => {
  for (const events of [[commit(undefined, 'main', 2), { ...tree(21, 'main', 1, 3), cat: 'blink.user_timing' }],
    [{ ...commit(undefined, 'main', 2), pid: 99 }, tree(21, 'main', 1, 3)],
    [commit(undefined, 'main', 2), tree(21, 'main', 1, 1)]])
    assert.throws(() => nativePageRoute(events, url, 'main', { browserPid: 10 }), /provenance/);
});
test('a fresh browser inventory resolves an overlapping old renderer without choosing by arrival time', () => {
  const events = [commit(undefined, 'main', 2), tree(20, 'main', 1, 3), tree(21, 'main', 1, 4)];
  const inventory = [{ name: 'TracingStartedInBrowser', cat, pid: 10, ts: 5,
    args: { data: { frames: [{ frame: 'main', url, processId: 21 }] } } }];
  const result = nativePageRoute(events, url, 'main', { browserPid: 10, currentInventory: inventory });
  assert.deepEqual(result.route, { pid: 21, treeId: 1 });
  assert.equal(result.evidence[0].processIdSource, 'post-navigation-browser-inventory');
  for (const broken of [[{ ...inventory[0], ts: 1 }], [{ ...inventory[0], cat: 'blink.user_timing' }],
    [{ ...inventory[0], args: { data: { frames: [{ frame: 'other', url, processId: 21 }] } } }]])
    assert.throws(() => nativePageRoute(events, url, 'main', { browserPid: 10, currentInventory: broken }), /inventory provenance/);
  assert.throws(() => nativePageRoute([commit(20, 'main', 2), ...events.slice(1)], url, 'main', { browserPid: 10, currentInventory: inventory }), /contradictory/);
});
