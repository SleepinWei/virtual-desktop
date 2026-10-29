import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerSignature } from '../src/native-input-signature.js';
import { NativeFrames, visualSignature } from '../src/native-frames.js';
import { scene, resource, identity, ack } from './frame-fixtures.js';

const point = { type: 'pointer', x: 300, y: 40 };
function page(time = 1) {
  const f = scene(time); f.surfaces[0].items[0].bounds = [0, 0, 960, 100];
  f.surfaces[0].items.push({ kind: 'solid', id: 9, bounds: [0, 200, 500, 300], color: [1,0,0,1],
    transform: [...identity], clipped: true, clip: [0,0,960,720], opacity: 1 });
  return f;
}

test('changes wholly outside the clicked native drawing region do not invalidate its signature', () => {
  const a = page(), b = page(2); b.surfaces[0].items[1].color = [0,1,0,1];
  assert.notEqual(visualSignature(a), visualSignature(b));
  assert.equal(pointerSignature(a, point), pointerSignature(b, point));
  assert.notEqual(pointerSignature(a, { ...point, y: 250 }), pointerSignature(b, { ...point, y: 250 }));
});

test('covered picture changes, new occlusion, movement into the region and edge coverage remain fenced', () => {
  const a = page();
  for (const edit of [
    b => b.surfaces[0].items[0].resource = resource('b').descriptor.id,
    b => b.surfaces[0].items[1].bounds = [290, 20, 30, 30],
    b => b.surfaces[0].items.push({ ...b.surfaces[0].items[1], id: 10, bounds: [280, 30, 60, 40] }),
    b => { const item = b.surfaces[0].items[1]; item.bounds = [301, 0, 30, 100]; },
  ]) { const b = page(2); edit(b); assert.notEqual(pointerSignature(a, point), pointerSignature(b, point)); }
});

test('nested native surface clips and transformed bounds conservatively preserve point coverage', () => {
  const a = page(), body = a.surfaces[0].items.pop(); body.bounds = [0,0,500,300]; body.clip = [0,0,500,300];
  const transform = [...identity]; transform[7] = 200;
  a.surfaces[0].items.push({ kind: 'surface', id: 2, transform, clipped: true, clip: [0,200,500,300], opacity: 1 });
  a.surfaces.push({ id: 2, rect: [0,0,500,300], items: [body], isolated: true });
  const b = structuredClone(a); b.surfaces[1].items[0].color = [0,1,0,1];
  assert.equal(pointerSignature(a, point), pointerSignature(b, point));
  assert.notEqual(pointerSignature(a, { ...point, y: 250 }), pointerSignature(b, { ...point, y: 250 }));
  const rotatedA = structuredClone(a), rotatedB = structuredClone(b);
  for (const frame of [rotatedA, rotatedB]) {
    const matrix = frame.surfaces[0].items[1].transform;
    matrix[0] = matrix[5] = 0; matrix[1] = -1; matrix[4] = 1; matrix[3] = 500;
  }
  assert.equal(pointerSignature(rotatedA, point), pointerSignature(rotatedB, point));
  assert.notEqual(pointerSignature(rotatedA, { ...point, y: 250 }), pointerSignature(rotatedB, { ...point, y: 250 }));
  const c = structuredClone(a); c.surfaces[0].items[1].clip = [0,0,500,500]; c.surfaces[0].items[1].transform[7] = 0;
  assert.notEqual(pointerSignature(a, point), pointerSignature(c, point));
});

test('scroll state and conservative rounded clipping stay in the point fence; wheels keep full-frame validation', () => {
  const a = page(), b = structuredClone(a); b.scrollOffsets.push({ id: 'body', offset: [0,1] });
  assert.notEqual(pointerSignature(a, point), pointerSignature(b, point));
  const c = structuredClone(a); c.surfaces[0].items[0].roundedClip = [0,0,960,100,20,20,20,20,20,20,20,20];
  assert.notEqual(pointerSignature(a, point), pointerSignature(c, point));
  for (const action of [{ type: 'wheel', x: 300, y: 40 }, { ...point, x: -1 }, { ...point, x: NaN }]) assert.equal(pointerSignature(a, action), null);
});

test('gateway accepts unchanged clicked regions but retains only two coordinate snapshots and fences old wheels', t => {
  const hub = new NativeFrames(() => ({ owner: 'human', epoch: 1 })); t.after(() => hub.close());
  const ingest = f => hub.ingest({ frame: f, resources: [{ id: resource('a').descriptor.id, data: resource('a').data }] });
  const a = page(); ingest(a); const { epoch } = hub.connect('viewer'), sent = [];
  hub.attach(epoch, 'viewer', packet => sent.push(packet), () => {}); hub.acknowledge(ack(sent[0]), 'viewer');
  const action = { ...point, connectionEpoch: epoch, seq: 1, frameId: a.id };
  const b = page(2); b.surfaces[0].items[1].color = [0,1,0,1]; ingest(b);
  assert.equal(hub.assertPointer(action), pointerSignature(b, point));
  assert.throws(() => hub.assertPresented({ ...action, type: 'wheel' }), error => error.code === 'STALE_FRAME');
  hub.acknowledge(ack(sent[1]), 'viewer'); const c = page(3); c.surfaces[0].items[1].color = [0,0,1,1]; ingest(c);
  hub.acknowledge(ack(sent[2]), 'viewer'); assert.equal(hub.get(epoch, 'viewer').coordinateFrames.size, 2);
  assert.throws(() => hub.assertPointer(action), error => error.code === 'STALE_FRAME');
  assert.equal(hub.assertPresented(action, false), hub.latest.signature);
});
