import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeTrace, capturePaint, extractPictures, findPageProvenance, partitionTrace, producerLaunchArgs } from '../experiments/chromium-paint/capture.js';

function skp(label) { return Buffer.concat([Buffer.from('skiapict'), Buffer.from(label)]); }

test('producerLaunchArgs restricts the source-backed shared-memory diagnostic without arbitrary flag injection', () => {
  assert.deepEqual(producerLaunchArgs(undefined), []);
  assert.deepEqual(producerLaunchArgs(32 * 1024 * 1024), [
    '--enable-features=kPerfettoBackendParams:shared_memory_size_bytes/33554432',
  ]);
  for (const value of ['33554432 --disable-web-security', 0, 4 * 1024 * 1024 + 1, 64 * 1024 * 1024, NaN]) {
    assert.throws(() => producerLaunchArgs(value), /4–32 MiB/);
  }
});

test('extractPictures keeps native SKP bytes, event provenance and layer identity', () => {
  const data = skp('native recording payload');
  const event = {
    name: 'cc::DisplayItemList:snapshot', cat: 'disabled-by-default-devtools.timeline.picture',
    ph: 'I', ts: 12345, pid: 81, tid: 82,
    args: { id: '0xabc', layer_id: 7, snapshot: { params: { layer_rect: { x: 4, y: 8, width: 960, height: 720 } }, skp64: data.toString('base64') } },
  };
  const original = structuredClone(event);
  const [picture] = extractPictures({ traceEvents: [{ name: 'unrelated' }, event] });
  assert.deepEqual(picture.data, data);
  assert.equal(picture.bytes, data.length);
  assert.equal(picture.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(picture.eventIndex, 1);
  assert.equal(picture.payloadPath, 'args.snapshot.skp64');
  assert.equal(picture.layerKey, 'layer:81:7');
  assert.equal(picture.event.ts, 12345);
  assert.deepEqual(picture.event.args.snapshot.params, event.args.snapshot.params);
  assert.equal(picture.event.args.snapshot.skp64.base64Length, data.toString('base64').length);
  assert.deepEqual(event, original, 'Extraction must not modify the raw trace');
});

test('extractPictures handles older object snapshot ids without joining renderer processes', () => {
  const picture = skp('legacy').toString('base64');
  const records = extractPictures([
    { name: 'cc::DisplayItemList', ph: 'O', pid: 1, id: '0x1', args: { snapshot: { skp64: picture } } },
    { name: 'cc::DisplayItemList', ph: 'O', pid: 2, id: '0x1', args: { snapshot: { skp64: picture } } },
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].displayListId, '0x1');
  assert.notEqual(records[0].layerKey, records[1].layerKey);
});

test('extractPictures associates id-less native snapshots with their enclosing renderer UpdateLayer', () => {
  const record = { name: 'cc::DisplayItemList:snapshot', ph: 'I', pid: 3, tid: 4, ts: 120,
    args: { snapshot: { skp64: skp('native').toString('base64') } } };
  const pictures = extractPictures([
    { name: 'UpdateLayer', ph: 'X', pid: 3, tid: 4, ts: 100, dur: 50, args: { layerId: 8, layerTreeId: 2 } },
    { name: 'UpdateLayer', ph: 'X', pid: 3, tid: 5, ts: 100, dur: 50, args: { layerId: 99 } },
    record,
  ]);
  assert.equal(pictures[0].layerId, 8);
  assert.equal(pictures[0].layerKey, 'layer:3:8');
  assert.equal(pictures[0].layerEvidence.layerTreeId, 2);
  assert.equal(pictures[0].layerEvidence.eventIndex, 0);
});

test('extractPictures rejects corrupt base64 and non-SKP bytes instead of claiming native capture', () => {
  const trace = value => [{ args: { snapshot: { skp64: value } } }];
  assert.throws(() => extractPictures(trace('!not base64!')), /Invalid SKP base64/);
  assert.throws(() => extractPictures(trace(Buffer.from('a PNG or JSON is not an SKP').toString('base64'))), /Invalid SKP file header/);
  assert.deepEqual(extractPictures([{ args: { screenshot: 'ignored' } }]), []);
});

test('analyzeTrace reports observed raster/draw records and does not treat recording playback as raster proof', () => {
  const result = analyzeTrace([
    { name: 'RasterTask', ph: 'B' }, { name: 'RasterTask', ph: 'E' },
    { name: 'RasterDecoderImpl::DoRasterCHROMIUM', ph: 'X' },
    { name: 'Display::DrawAndSwap', ph: 'X' },
    { name: 'DisplayItemList::Raster', ph: 'X' },
    { name: 'cc::DisplayItemList:snapshot', ph: 'I' },
  ]);
  assert.equal(result.eventCount, 6);
  assert.equal(result.raster.eventCount, 3, 'Records are counted individually, not as unique tasks');
  assert.deepEqual(result.raster.byPhase, { B: 1, E: 1, X: 1 });
  assert.equal(result.draw.eventCount, 1);
  assert.match(analyzeTrace([]).interpretation, /do not prove/);
});

test('capturePaint rejects external or credential-bearing fixtures before launching a browser', async () => {
  for (const url of ['https://example.com/', 'file:///tmp/fixture.html', 'http://localhost.example.com/', 'http://user:password@127.0.0.1/']) {
    await assert.rejects(capturePaint({ url, outputDir: '/tmp/unused-chromium-capture' }), /trusted HTTP\(S\) loopback/);
  }
});

test('partitionTrace uses marker timestamps even when producer delivery order is interleaved', () => {
  const events = [
    { name: 'clock_sync', ts: 100, args: { sync_id: 'start' } },
    { name: 'after-paint', ts: 250 },
    { name: 'before-paint', ts: 150 },
    { name: 'clock_sync', ts: 300, args: { sync_id: 'end' } },
    { name: 'clock_sync', ts: 200, args: { sync_id: 'middle' } },
    { name: 'metadata', ph: 'M' },
  ];
  const [before, after] = partitionTrace(events, { beforeStart: 'start', boundary: 'middle', afterEnd: 'end' });
  assert.deepEqual(before.eventIndices, [0, 2]);
  assert.deepEqual(after.eventIndices, [1, 4]);
  assert.throws(() => partitionTrace(events, { beforeStart: 'missing', boundary: 'middle', afterEnd: 'end' }), /Missing trace stage clock marker/);
});

test('partitionTrace accepts native User Timing stage marks without clock-sync metadata', () => {
  const events = ['start', 'middle', 'end'].map((name, index) => ({ name, cat: 'blink.user_timing', ts: 100 + index * 100 }));
  const [before, after] = partitionTrace(events, { beforeStart: 'start', boundary: 'middle', afterEnd: 'end' });
  assert.deepEqual(before.eventIndices, [0]);
  assert.deepEqual(after.eventIndices, [1]);
});

test('findPageProvenance excludes browser UI and unrelated frame URLs', () => {
  const url = 'http://127.0.0.1:8080/fixture.html';
  const trace = [
    { name: 'TracingStartedInBrowser', pid: 10, args: { data: { frames: [
      { frame: 'target', processId: 21, url }, { frame: 'other', processId: 22, url: 'about:blank' },
    ] } } },
    { name: 'CommitLoad', pid: 21, args: { data: { frame: 'target', url } } },
    { name: 'cc::DisplayItemList:snapshot', pid: 10, args: { snapshot: { skp64: skp('browser-ui').toString('base64') } } },
  ];
  const provenance = findPageProvenance(trace, url);
  assert.deepEqual(provenance.rendererPids, [21]);
  assert.equal(provenance.evidence.length, 2);
  assert.ok(!provenance.rendererPids.includes(10));
});
