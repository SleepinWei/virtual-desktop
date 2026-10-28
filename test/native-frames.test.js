import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeFrames, visualSignature } from '../src/native-frames.js';
import { scene, resource, ack } from './frame-fixtures.js';

const payload = (time, label = 'a', layer = 8) => ({ frame: scene(time, label, layer),
  resources: [{ id: resource(label).descriptor.id, data: resource(label).data }] });
const create = t => { const frames = new NativeFrames(() => ({ owner: 'agent', epoch: 1 })); t.after(() => frames.close()); return frames; };

test('a viewer attaching after native updates gets one current complete snapshot', t => {
  const frames = create(t); frames.ingest(payload(1));
  const { epoch } = frames.connect('viewer'); frames.ingest(payload(2, 'b'));
  const sent = []; frames.attach(epoch, 'viewer', message => sent.push(message), () => {});
  assert.equal(sent.length, 1); assert.equal(sent[0].seq, 1); assert.equal(sent[0].frame.id, '42:9:2');
  assert.deepEqual(frames.resource(epoch, 'viewer', resource('b').descriptor.id), resource('b').data);
  assert.throws(() => frames.resource(epoch, 'viewer', resource('a').descriptor.id), error => error.code === 'RESOURCE_NOT_OFFERED');
});

test('slow viewers pin in-flight resources and coalesce to the newest live frame', t => {
  const frames = create(t); frames.ingest(payload(1)); const { epoch } = frames.connect('viewer'), sent = [];
  frames.attach(epoch, 'viewer', packet => sent.push(packet), () => {});
  frames.ingest(payload(2, 'b')); frames.ingest(payload(3, 'c')); frames.ingest(payload(4, 'd'));
  assert.equal(sent.length, 2); assert.equal(frames.stats.connections[0].pending, 2);
  assert.equal(frames.stats.connections[0].coalesced, 1);
  assert.equal(frames.resources.has(resource('a').descriptor.id), true);
  assert.equal(frames.resources.has(resource('c').descriptor.id), false);
  frames.acknowledge(ack(sent[1]), 'viewer');
  assert.equal(sent[2].frame.id, '42:9:4'); assert.equal(sent[2].seq, 3);
  assert.equal(frames.resources.has(resource('a').descriptor.id), false);
});

test('coordinate input requires an ACK and the same current visual state', t => {
  const frames = create(t); frames.ingest(payload(1)); const { epoch } = frames.connect('viewer'), sent = [];
  frames.attach(epoch, 'viewer', packet => sent.push(packet), () => {});
  const action = { connectionEpoch: epoch, seq: 1, frameId: sent[0].frame.id };
  assert.throws(() => frames.assertPointer(action), error => error.code === 'STALE_FRAME');
  frames.acknowledge(ack(sent[0]), 'viewer');
  assert.equal(frames.assertPointer(action), visualSignature(scene(1)));
  frames.ingest(payload(2));
  assert.equal(frames.stats.duplicates, 1); assert.equal(sent.length, 1);
  assert.equal(frames.assertPointer(action), visualSignature(scene(1)));
  frames.ingest(payload(3, 'b'));
  assert.throws(() => frames.assertPointer(action), error => error.code === 'STALE_FRAME');
});

test('stream faults invalidate old frames and reconnecting creates a fresh epoch without retaining old resources', t => {
  const frames = create(t); frames.ingest(payload(1)); const first = frames.connect('viewer'), sent = [];
  frames.attach(first.epoch, 'viewer', packet => sent.push(packet), () => {});
  frames.unsupported('Unsupported native surface');
  assert.equal(sent.at(-1).kind, 'unsupported'); assert.equal(frames.stats.connections.length, 0);
  assert.equal(frames.stats.resourceBytes, 0); assert.equal(frames.stats.frameId, null);
  assert.throws(() => frames.connect('viewer'), error => error.code === 'NATIVE_FRAME_UNAVAILABLE');
  frames.ingest(payload(2, 'b'));
  const second = frames.connect('viewer'); assert.notEqual(second.epoch, first.epoch);
  assert.throws(() => frames.acknowledge(ack(sent[0]), 'viewer'), error => error.code === 'FRAME_CONNECTION_GONE');
});

test('bad resource bytes and invalid ACK inventories do not advance the live frame', t => {
  const frames = create(t); frames.ingest(payload(1));
  const broken = payload(2, 'b'); broken.resources[0].data = Buffer.from(broken.resources[0].data); broken.resources[0].data[0] ^= 1;
  assert.throws(() => frames.ingest(broken), error => error.code === 'NATIVE_RESOURCE_ERROR');
  assert.equal(frames.stats.frameId, '42:9:1');
  const { epoch } = frames.connect('viewer'), sent = []; frames.attach(epoch, 'viewer', packet => sent.push(packet), () => {});
  assert.throws(() => frames.acknowledge({ ...ack(sent[0]), resources: [] }, 'viewer'), error => error.code === 'INVALID_FRAME_ACK');
  assert.equal(frames.stats.connections[0].acked, 0);
  assert.throws(() => frames.get(epoch, 'agent'), error => error.code === 'FRAME_CONNECTION_GONE');
});

test('connection count is bounded and control changes do not create fake paint frames', t => {
  const frames = create(t); frames.ingest(payload(1)); const messages = [];
  const { epoch } = frames.connect('viewer'); frames.attach(epoch, 'viewer', packet => messages.push(packet), () => {});
  frames.connect('viewer'); frames.connect('viewer'); frames.connect('viewer');
  assert.throws(() => frames.connect('viewer'), error => error.code === 'VIEWER_LIMIT');
  frames.controlChanged(); assert.equal(messages.at(-1).kind, 'control'); assert.equal(frames.revision, 1);
  frames.disconnect(epoch); assert.equal(frames.stats.connections.length, 3);
});
