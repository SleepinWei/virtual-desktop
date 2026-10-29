import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDecoder } from '../experiments/chromium-paint/font-runtime.js';
import { FrameReceiver, validateFrame } from '../experiments/chromium-paint/frame-protocol.js';
import { normalizeNativeFrame } from '../experiments/chromium-paint/native-frame.js';
import { openNativeFont } from '../src/native-font-file.js';
import { NativeFrames } from '../src/native-frames.js';
import { scene, packet, nativeEvent, resource } from './frame-fixtures.js';

// Deliberately synthetic font bytes: protocol/cache evidence only, not decoding.
const data = Buffer.from('synthetic-font-program-unit-test-only');
const id = createHash('sha256').update(data).digest('hex');
const descriptor = { kind: 'font', id, path: `fonts/${id}.font`, bytes: data.length };
function frame(time = 1) {
  const value = scene(time);
  value.resources[0].fonts = [id]; value.resources.unshift(structuredClone(descriptor));
  return value;
}
function mockKit() {
  const calls = { add: 0, remove: 0, pictures: 0, deleted: 0, registryDeleted: 0 };
  return { calls, HEAPU8: new Uint8Array(1024 * 1024), _malloc: () => 8, _free() {},
    RemoteFontRegistry: class {
      _addFont() { calls.add++; return true; }
      _makePicture() { calls.pictures++; return { delete() { calls.deleted++; } }; }
      removeFont() { calls.remove++; }
      delete() { calls.registryDeleted++; }
    },
    MakePicture() { throw new Error('External fonts must use the registry decoder'); },
  };
}
const respond = resource => new Response(resource.kind === 'font' ? data : resourceFixture);
const resourceFixture = resource('a').data;

test('font dependencies precede SKPs, load once and enter the presented ACK inventory', async () => {
  const kit = mockKit(), fetched = [], decoder = createNativeDecoder(kit, { fetchResource: async resource => { fetched.push(resource.id); return respond(resource); } });
  const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() {} });
  const first = await receiver.receive(packet(1, frame(1)));
  assert.equal(first.status, 'presented'); assert.deepEqual(first.ack.resources, frame().resources.map(r => r.id).sort());
  await receiver.receive(packet(2, frame(2)));
  assert.equal(fetched.length, 2); assert.equal(kit.calls.add, 1); assert.equal(kit.calls.pictures, 1);
  receiver.reset('reset'); decoder.dispose();
  assert.equal(kit.calls.remove, 1); assert.equal(kit.calls.deleted, 1); assert.equal(kit.calls.registryDeleted, 1);
});

test('missing, corrupted and unsupported font assets never present or ACK a frame', async () => {
  for (const mode of ['missing', 'corrupt', 'unsupported']) {
    const kit = mockKit(); if (mode === 'unsupported') delete kit.RemoteFontRegistry;
    let presents = 0;
    const decoder = createNativeDecoder(kit, { fetchResource: async () => mode === 'missing'
      ? new Response('', { status: 404 }) : new Response(mode === 'corrupt' ? Buffer.alloc(data.length) : data) });
    const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() { presents++; } });
    await assert.rejects(receiver.receive(packet(1, frame())));
    assert.equal(presents, 0); assert.equal(receiver.state.presented, 0); assert.equal(kit.calls.pictures, 0);
    decoder.dispose();
  }
  const decoder = createNativeDecoder(mockKit(), { fetchResource: respond });
  await assert.rejects(decoder.load(frame().resources[1]), /Missing native font dependency/);
  decoder.dispose();
});

test('overlapping font loads share one download and stale release cannot remove a newer user', async () => {
  const kit = mockKit(); let downloads = 0;
  const decoder = createNativeDecoder(kit, { fetchResource: async () => { downloads++; await Promise.resolve(); return new Response(data); } });
  const [one, two] = await Promise.all([decoder.load(descriptor), decoder.load(descriptor)]);
  assert.equal(downloads, 1); assert.equal(kit.calls.add, 1);
  decoder.release(one); assert.equal(kit.calls.remove, 0);
  decoder.release(two); assert.equal(kit.calls.remove, 1); assert.equal(decoder.state.fonts, 0);
  decoder.dispose();
});

test('font dependency inventories reject missing, orphan, reordered and oversized resources', () => {
  const cases = [value => value.resources.shift(), value => value.resources[1].fonts = [],
    value => value.resources.reverse(), value => value.resources[0].bytes = 64 * 1024 ** 2 + 1,
    value => value.resources[1].fonts.push(id), value => value.surfaces[0].items[0].resource = id];
  for (const change of cases) { const value = frame(); change(value); assert.throws(() => validateFrame(value)); }
  assert.equal(validateFrame(frame()).resources[0].kind, 'font');
});

test('native normalization preserves external font references without placing programs in JSON', () => {
  const event = nativeEvent();
  for (const entry of event.args.snapshot.entries.filter(entry => entry.kind === 'picture')) {
    Object.assign(entry.record, { font_error: false, font_count: 1, fonts: [{ id, bytes: data.length }] });
  }
  const normalized = normalizeNativeFrame(event);
  assert.deepEqual(normalized.frame.resources[0], descriptor); assert.equal(normalized.fonts.size, 1);
  assert.equal(normalized.bytes.has(id), false); assert.equal(JSON.stringify(normalized.frame).includes(data.toString()), false);
  event.args.snapshot.entries[0].record.font_error = true;
  assert.throws(() => normalizeNativeFrame(event), /font export failed/);
});

test('binary font file verifies hash, rejects symlinks and pins an in-flight stream through eviction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-font-unit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, id + '.font'); await writeFile(path, data);
  const asset = openNativeFont(path, descriptor), stream = asset.stream();
  asset.close(); const received = [];
  for await (const chunk of stream) received.push(chunk);
  assert.deepEqual(Buffer.concat(received), data);
  assert.throws(() => asset.stream(), /closed/);
  await writeFile(path, Buffer.alloc(data.length)); assert.throws(() => openNativeFont(path, descriptor), /SHA-256/);
  await rm(path); const target = join(directory, 'target'); await writeFile(target, data); await symlink(target, path);
  assert.throws(() => openNativeFont(path, descriptor));
});

test('gateway serves file-backed fonts only to viewers with an offered frame and never accepts font IPC buffers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-font-gateway-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, id + '.font'); await writeFile(path, data);
  const hub = new NativeFrames(() => ({})); t.after(() => hub.close());
  const payload = { frame: frame(), resources: [{ id, filePath: path }, { id: resource('a').descriptor.id, data: resourceFixture }] };
  hub.ingest(payload); assert.equal(hub.stats.resourceBytes, data.length + resourceFixture.length);
  const { epoch } = hub.connect('viewer'); hub.attach(epoch, 'viewer', () => {}, () => {});
  const chunks = []; for await (const chunk of hub.resource(epoch, 'viewer', id).stream()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data);
  assert.throws(() => hub.resource(epoch, 'agent', id));
  assert.throws(() => hub.ingest({ ...payload, resources: [{ id, data }, payload.resources[1]] }), /binary asset store/);
});

test('a viewer closed during a font download cannot recreate its WASM registry', async () => {
  const kit = mockKit(); let deliver;
  const decoder = createNativeDecoder(kit, { fetchResource: () => new Promise(resolve => deliver = resolve) });
  const loading = decoder.load(descriptor);
  decoder.dispose(); deliver(new Response(data));
  await assert.rejects(loading, /closed/);
  assert.equal(kit.calls.add, 0); assert.equal(decoder.state.fonts, 0);
});

test('superseded font subsets and their decoded pictures are retired after the new frame presents', async () => {
  const other = Buffer.from('another synthetic font subset for memory retirement');
  const otherId = createHash('sha256').update(other).digest('hex');
  const next = scene(2, 'b');
  next.resources[0].fonts = [otherId];
  next.resources.unshift({ kind: 'font', id: otherId, path: `fonts/${otherId}.font`, bytes: other.length });
  const kit = mockKit();
  const decoder = createNativeDecoder(kit, { fetchResource: async value => new Response(value.kind === 'font'
    ? value.id === id ? data : other : value.id === resource('a').descriptor.id ? resourceFixture : resource('b').data) });
  const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() {} });
  await receiver.receive(packet(1, frame()));
  const result = await receiver.receive(packet(2, next));
  assert.deepEqual(result.ack.resources, next.resources.map(value => value.id).sort());
  assert.equal(kit.calls.remove, 1); assert.equal(kit.calls.deleted, 1);
  assert.equal(decoder.state.fonts, 1); assert.equal(receiver.state.cachedResources, 2);
  receiver.reset('closed'); decoder.dispose();
});

test('destroying completed or aborted HTTP font streams never closes the pinned resource handle', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-font-stream-reuse-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, id + '.font'); await writeFile(path, data);
  const asset = openNativeFont(path, descriptor); t.after(() => asset.close());
  const { once } = await import('node:events');
  const first = asset.stream(); for await (const chunk of first) {}
  first.destroy();
  const aborted = asset.stream(), close = once(aborted, 'close'); aborted.destroy(); await close;
  const result = []; for await (const chunk of asset.stream()) result.push(chunk);
  assert.deepEqual(Buffer.concat(result), data);
});
