import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePageRoute } from '../experiments/chromium-engine/page-route.js';
import { ChromiumSession } from '../experiments/chromium-engine/session.js';

const url = 'https://info.cern.ch/page';
const commit = (pid, frame, ts, address = url) => ({ name: 'FrameCommittedInBrowser', pid: 10, ts, args: { data: { url: address, frame, processId: pid } } });
const tree = (pid, frame, treeId, ts) => ({ name: 'SetLayerTreeId', pid, ts, args: { data: { frame, layerTreeId: treeId } } });

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
