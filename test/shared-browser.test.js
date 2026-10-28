import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeLeaseRouter, SharedChromiumHost } from '../experiments/chromium-engine/shared-browser.js';

const frame = (pid, treeId) => ({ pid, ts: 1, snapshot: { tree_id: treeId } });
test('native pool routes bound frames to one lease and rejects a shared renderer claim', () => {
  const router = new NativeLeaseRouter(), a = [], b = [];
  router.attach('A', message => a.push(message), () => {});
  router.attach('B', message => b.push(message), () => {});
  router.bind('A', { pid: 101, treeId: 1 });
  assert.throws(() => router.bind('B', { pid: 101, treeId: 2 }), /share a renderer/);
  router.bind('B', { pid: 102, treeId: 1 });
  router.receive(frame(101, 1)); router.receive(frame(102, 1));
  assert.deepEqual(a.map(message => message.pid), [101]);
  assert.deepEqual(b.map(message => message.pid), [102]);
  router.receive({ pid: 102, error: 'producer failed' });
  assert.equal(a.length, 1); assert.equal(b.at(-1).error, 'producer failed');
});
test('retired native routes cannot leak to a fresh context or be rebound', () => {
  const router = new NativeLeaseRouter(), c = [];
  router.attach('A', () => {}, () => {}); router.bind('A', { pid: 101, treeId: 1 }); router.detach('A');
  router.attach('C', message => c.push(message), () => {});
  router.receive(frame(101, 1));
  assert.equal(c.length, 0);
  assert.throws(() => router.bind('C', { pid: 101, treeId: 1 }), /retired/);
  router.bind('C', { pid: 103, treeId: 1 }); router.receive(frame(103, 1));
  assert.equal(c.length, 1);
});
test('pool admission is bounded and recycled history cannot grow without draining', () => {
  const router = new NativeLeaseRouter({ maxActive: 1, maxRetired: 1 });
  router.attach('A', () => {}, () => {});
  assert.throws(() => router.attach('B', () => {}, () => {}), /drain or recycle/);
  router.bind('A', { pid: 101, treeId: 1 }); router.detach('A');
  assert.throws(() => router.attach('B', () => {}, () => {}), /drain or recycle/);
});
test('browser-wide startup traces are serialized, including after an earlier failure', async () => {
  const host = new SharedChromiumHost(); host.browser = { isConnected: () => true };
  const events = []; let release;
  const first = host.trace(async () => { events.push('first'); await new Promise(resolve => { release = resolve; }); throw new Error('first failed'); });
  const second = host.trace(async () => { events.push('second'); return 2; });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['first']); release();
  await assert.rejects(first, /first failed/); assert.equal(await second, 2);
  assert.deepEqual(events, ['first', 'second']);
});
