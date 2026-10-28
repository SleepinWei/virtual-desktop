import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FrameChannel, FrameReceiver, validateFrame } from '../experiments/chromium-paint/frame-protocol.js';
import { normalizeNativeFrame, selectNativeFrame } from '../experiments/chromium-paint/native-frame.js';
import { nativeEvent, groupedScene, scene, packet, ack, resource } from './frame-fixtures.js';

test('native frame capture cannot use pixel APIs or DOM geometry as a drawing payload', async () => {
  const source = await readFile(new URL('../experiments/chromium-paint/frame-capture.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.screenshot\s*\(|captureScreenshot|startScreencast|toDataURL|createCanvas|getBoundingClientRect|boundingBox|innerHTML|outerHTML/);
});

test('native frames preserve surface grouping, reverse native draw order and deduplicate unchanged original bytes', () => {
  const event = nativeEvent(), original = structuredClone(event);
  const result = normalizeNativeFrame(event);
  assert.deepEqual(event, original);
  assert.deepEqual(result.frame.surfaces.map(surface => surface.items.map(item => item.id)), [[5, 2], [4, 3]]);
  assert.equal(result.frame.surfaces[0].items[1].opacity, .5);
  assert.equal(result.frame.resources.length, 1);
  assert.deepEqual(result.bytes.get(resource('a').descriptor.id), resource('a').data);
  assert.deepEqual(result.frame.scrollOffsets[0].offset, [0, 180]);
});

test('stage selection uses native timestamps and renderer provenance; newest unsupported frames fail closed', () => {
  const options = { rendererPids: [42], start: 10, end: 30, viewport: { width: 960, height: 720 } };
  const events = [nativeEvent(20), { ...nativeEvent(25), pid: 99 }, nativeEvent(15)];
  assert.equal(selectNativeFrame(events, options).frame.native.ts, 20);
  const bad = nativeEvent(22); bad.args.snapshot.unsupported.push('surface-effects');
  assert.throws(() => selectNativeFrame([...events, bad], options), /surface-effects/);
  assert.throws(() => selectNativeFrame(events, { ...options, rendererPids: [] }), /provenance/);
  assert.throws(() => normalizeNativeFrame({ ...nativeEvent(), cat: 'blink.user_timing' }), /provenance/);
  const corrupt = nativeEvent(); corrupt.args.snapshot.entries[0].record.skp64 = Buffer.from('PNG test').toString('base64');
  assert.throws(() => normalizeNativeFrame(corrupt), /SKP bytes/);
});

test('explicit native counts distinguish omitted empty arrays from missing frame data', () => {
  const event = nativeEvent(), raw = event.args.snapshot;
  raw.surfaces.length = 1; raw.surface_count = 1; raw.entry_count = 0; raw.scroll_count = 0;
  delete raw.entries; delete raw.scroll_offsets; delete raw.unsupported;
  const { frame } = normalizeNativeFrame(event);
  assert.deepEqual(frame.surfaces[0].items, []); assert.deepEqual(frame.resources, []); assert.deepEqual(frame.scrollOffsets, []);
  delete raw.entry_count;
  assert.throws(() => normalizeNativeFrame(event), /collections/);
});

test('complete frames reject cycles, duplicate layers, orphan surfaces, missing resources, 3D and invalid clips', () => {
  const changes = [
    value => { value.surfaces[1].items.push({ ...value.surfaces[0].items[1], id: 1 }); },
    value => { value.surfaces[1].items.push(structuredClone(value.surfaces[0].items[0])); },
    value => { value.surfaces.push({ id: 99, rect: [0, 0, 1, 1], items: [] }); },
    value => { value.resources = []; },
    value => { value.surfaces[0].items[0].transform[12] = 1; },
    value => { value.surfaces[0].items[0].clip[2] = -1; },
    value => { value.resources[0].path = '../private'; },
  ];
  for (const change of changes) { const value = groupedScene(); change(value); assert.throws(() => validateFrame(value), /Invalid native frame/); }
});

test('channel bounds unacknowledged work and coalesces to the newest complete snapshot', () => {
  const channel = new FrameChannel('test-epoch');
  const first = channel.offer(scene(1)).packet, second = channel.offer(scene(2)).packet;
  assert.equal(channel.offer(scene(3)).status, 'queued');
  assert.equal(channel.offer(scene(4)).status, 'queued');
  assert.deepEqual(channel.state, { epoch: 'test-epoch', sent: 2, acked: 0, pending: 2, queued: true, coalesced: 1, knownResources: 0 });
  const response = channel.acknowledge(ack(second));
  assert.equal(response.packet.frame.native.ts, 4);
  assert.equal(response.packet.seq, 3);
  assert.deepEqual(response.packet.resources, []);
  assert.equal(channel.state.pending, 1);
  assert.equal(channel.acknowledge(ack(first)).accepted, false);
});

test('sending is not an ACK; forged future, epoch, frame or resource inventories cannot advance state', () => {
  const channel = new FrameChannel('test-epoch');
  const first = channel.offer(scene(1)).packet, second = channel.offer(scene(2)).packet;
  assert.equal(first.resources.length, 1); assert.equal(second.resources.length, 1);
  for (const invalid of [ { ...ack(first), seq: 99 }, { ...ack(first), epoch: 'old-epoch' },
    { ...ack(first), frameId: second.frame.id }, { ...ack(first), resources: [] },
    { ...ack(first), resources: [resource('private').descriptor.id] } ]) {
    assert.throws(() => channel.acknowledge(invalid), /Invalid native frame/);
    assert.equal(channel.state.acked, 0);
  }
  first.frame.surfaces.length = 0;
  assert.equal(channel.acknowledge(ack(second)).accepted, true, 'Caller mutations cannot alter stored in-flight snapshots');
});

test('receiver atomically replaces membership, reuses resources and reports removals only after presentation', async () => {
  const drawn = [], loads = [], released = [];
  const receiver = new FrameReceiver('test-epoch', { load: async descriptor => { loads.push(descriptor.id); return { id: descriptor.id }; },
    present: frame => drawn.push(frame.id), release: value => released.push(value.id) });
  const first = await receiver.receive(packet(1));
  const second = await receiver.receive(packet(2, scene(2, 'a', 9)));
  assert.equal(first.ack.seq, 1); assert.deepEqual(second.removedLayerIds, [8]);
  assert.deepEqual(drawn, ['42:9:1', '42:9:2']); assert.equal(loads.length, 1); assert.equal(released.length, 0);
  assert.equal((await receiver.receive(packet(1))).status, 'stale'); assert.equal(drawn.length, 2);
});

test('a late asynchronous decode cannot overwrite a newer presented frame or leak its resources', async () => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; }), drawn = [], released = [];
  const receiver = new FrameReceiver('test-epoch', {
    load: async descriptor => descriptor.id === resource('a').descriptor.id ? await delayed : { id: descriptor.id },
    present: frame => drawn.push(frame.id), release: value => released.push(value.id),
  });
  const old = receiver.receive(packet(1));
  await receiver.receive(packet(2, scene(2, 'b')));
  finish({ id: resource('a').descriptor.id });
  assert.equal((await old).status, 'stale');
  assert.deepEqual(drawn, ['42:9:2']); assert.deepEqual(released, [resource('a').descriptor.id]);
  assert.equal(receiver.state.seq, 2); assert.equal(receiver.state.cachedResources, 1);
});

test('failed resource decoding releases new allocations, preserves visible state and emits no ACK', async () => {
  const drawn = [], released = [];
  const receiver = new FrameReceiver('test-epoch', {
    load: async descriptor => { if (descriptor.id === resource('b').descriptor.id) throw new Error('decoder failure'); return { id: descriptor.id }; },
    present: frame => drawn.push(frame.id), release: value => released.push(value.id),
  });
  await receiver.receive(packet(1));
  const next = scene(2, 'c'), extra = scene(2, 'b', 9);
  next.resources.push(...extra.resources); next.surfaces[0].items.push(...extra.surfaces[0].items);
  await assert.rejects(receiver.receive(packet(2, next)), /decoder failure/);
  assert.deepEqual(drawn, ['42:9:1']); assert.equal(receiver.state.seq, 1);
  assert.equal(receiver.state.cachedResources, 1); assert.deepEqual(released, [resource('c').descriptor.id]);
});

test('resource evictions are reflected in ACKs and are downloaded again when revisited', async () => {
  const loads = [], released = [];
  const receiver = new FrameReceiver('test-epoch', { cacheBytes: resource('a').data.length,
    load: async descriptor => { loads.push(descriptor.id); return { id: descriptor.id }; }, present() {}, release: value => released.push(value.id) });
  await receiver.receive(packet(1));
  const second = await receiver.receive(packet(2, scene(2, 'b')));
  assert.deepEqual(second.ack.resources, [resource('b').descriptor.id]);
  await receiver.receive(packet(3, scene(3)));
  assert.deepEqual(loads, ['a', 'b', 'a'].map(label => resource(label).descriptor.id));
  assert.equal(released.length, 2);
});

test('epoch reset cancels old in-flight work and rejects delayed packets from the previous session', async () => {
  let finish;
  const released = [], drawn = [];
  const receiver = new FrameReceiver('test-epoch', { load: () => new Promise(resolve => { finish = resolve; }),
    present: frame => drawn.push(frame.id), release: value => released.push(value) });
  const pending = receiver.receive(packet(1)); receiver.reset('new-epoch'); finish({ test: true });
  assert.equal((await pending).status, 'stale'); assert.equal(released.length, 1); assert.deepEqual(drawn, []);
  await assert.rejects(receiver.receive(packet(2)), /epoch/); assert.equal(receiver.state.seq, 0);
});
