import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeDecoder } from '../experiments/chromium-paint/font-runtime.js';
import { FRAME_LIMITS, FrameReceiver, validateFrame } from '../experiments/chromium-paint/frame-protocol.js';
import { normalizeNativeFrame } from '../experiments/chromium-paint/native-frame.js';
import { NativeFrames } from '../src/native-frames.js';
import { siteAccessIssue } from '../experiments/chromium-engine/sites.js';
import { imageAnimationArgs } from '../experiments/chromium-engine/browser-runtime.js';
import { nativeEvent, packet, resource, scene } from './frame-fixtures.js';

// Protocol fixtures only. Actual PNG/CSS/rounded-mask pixels are checked by
// diagnose-fonts --images against an independent ordinary browser reference.
const data = Buffer.from('synthetic compressed image protocol fixture');
const id = createHash('sha256').update(data).digest('hex');
const descriptor = { kind: 'image', id, bytes: data.length, width: 32, height: 32, path: `images/${id}.img` };
function frame(time = 1, label = 'a', image = descriptor) {
  const value = scene(time, label);
  value.resources[0].images = [image.id]; value.resources.unshift(structuredClone(image));
  return value;
}
function mockKit({ width = 32, rejected = false } = {}) {
  const calls = { images: 0, add: 0, remove: 0, pictures: 0, pictureDeleted: 0, cacheBytes: 0 };
  return { calls, HEAPU8: new Uint8Array(1024 * 1024), _malloc: () => 8, _free() {},
    setDecodeCacheLimitBytes(bytes) { calls.cacheBytes = bytes; },
    MakeImageFromEncoded() { throw new Error('Images must not retain eager RGBA allocations'); },
    RemoteFontRegistry: class {
      _addEncodedImage(id, pointer, bytes, expectedWidth, height, firstFrame) { calls.images++; calls.firstFrame = firstFrame; if (expectedWidth !== width || rejected) return -1; calls.add++; return 1; }
      removeImage() { calls.remove++; }
      _makePicture() { calls.pictures++; return { delete() { calls.pictureDeleted++; } }; }
      delete() {}
    },
    MakePicture() { throw new Error('External-image SKPs must use the strict registry'); },
  };
}
const response = entry => new Response(entry.kind === 'image' ? data : resource('a').data);

test('native image normalization transports original binary references with dimensions and rounded clips', () => {
  const event = nativeEvent();
  event.args.snapshot.surfaces[0].isolated = true;
  for (const entry of event.args.snapshot.entries.filter(item => item.kind === 'picture')) {
    Object.assign(entry.record, { image_error: false, image_count: 1, images: [{ id, bytes: data.length, width: 32, height: 32 }] });
    entry.rounded_clip = [1, 2, 32, 32, 4, 4, 4, 4, 4, 4, 4, 4];
    entry.blend_mode = 'DstIn';
  }
  const normalized = normalizeNativeFrame(event);
  assert.deepEqual(normalized.frame.resources[0], descriptor);
  assert.equal(normalized.images.size, 1); assert.equal(normalized.bytes.has(id), false);
  assert.equal(normalized.frame.surfaces[0].isolated, true);
  assert.ok(normalized.frame.surfaces.flatMap(surface => surface.items).some(item => item.blendMode === 'DstIn'));
  assert.equal(JSON.stringify(normalized.frame).includes(data.toString()), false);
  assert.ok(normalized.frame.surfaces.flatMap(surface => surface.items).some(item => item.roundedClip?.[0] === 1));
  assert.equal(normalizeNativeFrame(event, { imageAnimationPolicy: 'first-frame' }).frame.resources[0].animationPolicy, 'first-frame');
  event.args.snapshot.entries[0].record.image_error = true;
  assert.throws(() => normalizeNativeFrame(event), /image export failed/);
});

test('images decode locally once, precede their SKP and enter the presented ACK inventory', async () => {
  const kit = mockKit(), fetched = [], decoder = createNativeDecoder(kit, { fetchResource: async entry => { fetched.push(entry.kind || 'picture'); return response(entry); } });
  const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() {} });
  const first = await receiver.receive(packet(1, frame()));
  await receiver.receive(packet(2, frame(2)));
  assert.deepEqual(fetched, ['image', 'picture']);
  assert.deepEqual(first.ack.resources, frame().resources.map(entry => entry.id).sort());
  assert.equal(kit.calls.images, 1); assert.equal(kit.calls.add, 1);
  assert.equal(decoder.state.encodedImageBytes, data.length); assert.equal(kit.calls.cacheBytes, 32 * 1024 * 1024);
  receiver.reset('closed'); decoder.dispose();
  assert.equal(kit.calls.remove, 1); assert.equal(kit.calls.pictureDeleted, 1);
});

test('corrupt bytes, dimension mismatches and rejected images never present or ACK a frame', async () => {
  for (const mode of ['corrupt', 'dimensions', 'registry', 'missing']) {
    const kit = mockKit({ width: mode === 'dimensions' ? 31 : 32, rejected: mode === 'registry' });
    let presents = 0;
    const decoder = createNativeDecoder(kit, { fetchResource: async entry => mode === 'missing' ? new Response('', { status: 404 })
      : mode === 'corrupt' ? new Response(Buffer.alloc(entry.bytes)) : response(entry) });
    const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() { presents++; } });
    await assert.rejects(receiver.receive(packet(1, frame())));
    assert.equal(presents, 0); assert.equal(receiver.state.presented, 0); assert.equal(kit.calls.pictures, 0);
    assert.equal(decoder.state.images, 0); decoder.dispose();
  }
  const decoder = createNativeDecoder(mockKit(), { fetchResource: response });
  await assert.rejects(decoder.load(frame().resources[1]), /Missing native image dependency/); decoder.dispose();
});

test('image inventories reject missing dependencies, orphan images, reorderings and bounded per-frame decode work', () => {
  const changes = [value => value.resources.shift(), value => value.resources.reverse(), value => value.resources[1].images = [],
    value => value.resources[1].images.push(id), value => value.resources[0].width = 8193,
    value => value.resources[0].height = 0, value => value.resources[0].bytes = FRAME_LIMITS.imageBytes + 1,
    value => value.surfaces[0].items[0].resource = id,
    value => value.surfaces[0].items[0].blendMode = 'unknown', value => value.surfaces[0].isolated = 'yes',
    value => value.surfaces[0].items[0].roundedClip = [0, 0, 32, 32, -1, 4, 4, 4, 4, 4, 4, 4]];
  for (const change of changes) { const value = frame(); change(value); assert.throws(() => validateFrame(value)); }
  const value = frame();
  value.resources[0].width = value.resources[0].height = 4096;
  for (const digit of ['b', 'c', 'd', 'e']) {
    const next = { ...value.resources[0], id: digit.repeat(64), path: `images/${digit.repeat(64)}.img` };
    value.resources.at(-1).images.push(next.id); value.resources.splice(1, 0, next);
  }
  assert.throws(() => validateFrame(value), /image decode workload/);
});

test('overlapping image loads share a decode and disposing an in-flight viewer cannot repopulate its registry', async () => {
  const kit = mockKit(); let fetched = 0;
  const decoder = createNativeDecoder(kit, { fetchResource: async () => { fetched++; await Promise.resolve(); return new Response(data); } });
  const [one, two] = await Promise.all([decoder.load(descriptor), decoder.load(descriptor)]);
  assert.equal(fetched, 1); assert.equal(kit.calls.images, 1);
  decoder.release(one); assert.equal(kit.calls.remove, 0);
  decoder.release(two); assert.equal(kit.calls.remove, 1); decoder.dispose();
  let deliver;
  const closed = createNativeDecoder(kit, { fetchResource: () => new Promise(resolve => deliver = resolve) });
  const loading = closed.load(descriptor); closed.dispose(); deliver(new Response(data));
  await assert.rejects(loading, /closed/); assert.equal(closed.state.images, 0);
});

test('animated image containers cannot silently become a first-frame preview', async () => {
  for (const length of [24, 144]) {
    const encoded = Buffer.alloc(length); encoded.writeUInt32BE(length, 0); encoded.write('ftyp', 4); encoded.write('avif', 8);
    encoded.write('avis', length === 24 ? 16 : 132);
    const hash = createHash('sha256').update(encoded).digest('hex'), kit = mockKit();
    const decoder = createNativeDecoder(kit, { fetchResource: async () => new Response(encoded) });
    await assert.rejects(decoder.load({ ...descriptor, id: hash, bytes: encoded.length, path: `images/${hash}.img` }), /Animated images|excessive image metadata/);
    assert.equal(kit.calls.images, 0); assert.equal(decoder.state.images, 0); decoder.dispose();
  }
});

test('first-frame images require an explicit bounded policy that cannot change inside a cached resource', async () => {
  assert.deepEqual(imageAnimationArgs('first-frame'), ['--blink-settings=imageAnimationPolicy=2']);
  assert.deepEqual(imageAnimationArgs(), []); assert.throws(() => imageAnimationArgs('arbitrary'));
  const kit = mockKit(), decoder = createNativeDecoder(kit, { fetchResource: async entry => response(entry) });
  const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() {} });
  const frozen = frame(); frozen.resources[0].animationPolicy = 'first-frame';
  await receiver.receive(packet(1, frozen)); assert.equal(kit.calls.firstFrame, true);
  await assert.rejects(receiver.receive(packet(2, frame(2))), /changed resource descriptor/);
  const invalid = frame(); invalid.resources[0].animationPolicy = 'play'; assert.throws(() => validateFrame(invalid));
  const picture = frame(); picture.resources[1].animationPolicy = 'first-frame'; assert.throws(() => validateFrame(picture));
  receiver.reset('closed'); decoder.dispose();
});

test('superseded images and dependent pictures leave the cache immediately after atomic presentation', async () => {
  const other = Buffer.from('another synthetic compressed image fixture');
  const otherId = createHash('sha256').update(other).digest('hex');
  const nextImage = { ...descriptor, id: otherId, bytes: other.length, path: `images/${otherId}.img` };
  const kit = mockKit(), decoder = createNativeDecoder(kit, { fetchResource: async entry => new Response(entry.kind === 'image'
    ? entry.id === id ? data : other : entry.id === resource('a').descriptor.id ? resource('a').data : resource('b').data) });
  const receiver = new FrameReceiver('test-epoch', { load: decoder.load, release: decoder.release, present() {} });
  await receiver.receive(packet(1, frame()));
  const result = await receiver.receive(packet(2, frame(2, 'b', nextImage)));
  assert.deepEqual(result.ack.resources, frame(2, 'b', nextImage).resources.map(entry => entry.id).sort());
  assert.equal(kit.calls.remove, 1); assert.equal(kit.calls.pictureDeleted, 1);
  assert.equal(decoder.state.images, 1); receiver.reset('closed'); decoder.dispose();
});

test('gateway keeps images file-backed and capability-scoped, with independent HTTP stream lifetime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vd-image-unit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, id + '.img'); await writeFile(path, data);
  const hub = new NativeFrames(() => ({})); t.after(() => hub.close());
  const payload = { frame: frame(), resources: [{ id, filePath: path }, { id: resource('a').descriptor.id, data: resource('a').data }] };
  hub.ingest(payload);
  const { epoch } = hub.connect('viewer'); hub.attach(epoch, 'viewer', () => {}, () => {});
  assert.throws(() => hub.resource(epoch, 'agent', id));
  const stream = hub.resource(epoch, 'viewer', id).stream(); hub.close();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data);
  assert.throws(() => hub.ingest({ ...payload, resources: [{ id, data }, payload.resources[1]] }), /binary asset store/);
});

test('Xiaohongshu access rejection is session-specific, strips tokens and only matches the trusted error page', () => {
  const issue = siteAccessIssue('xiaohongshu', 'https://www.xiaohongshu.com/website-login/error?error_code=300012&token=secret');
  assert.match(issue, /当前浏览会话/); assert.equal(issue.includes('secret'), false);
  for (const address of ['https://www.xiaohongshu.com/explore?error_code=300012',
    'https://xiaohongshu.com.evil.example/website-login/error?error_code=300012',
    'https://www.xiaohongshu.com/website-login/error?error_code=1', 'bad-url']) assert.equal(siteAccessIssue('xiaohongshu', address), null);
  assert.equal(siteAccessIssue('bilibili', 'https://www.xiaohongshu.com/website-login/error?error_code=300012'), null);
});
