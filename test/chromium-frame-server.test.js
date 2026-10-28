import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLab } from '../experiments/chromium-paint/frame-server.js';
import { scene, resource, ack } from './frame-fixtures.js';

test('loopback frame transport bounds pending work, requires presented ACKs, and serves only listed original resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-frame-server-'));
  const lab = createFrameLab({ outputDir: directory });
  try {
    await mkdir(join(directory, 'pictures'));
    for (const label of ['a', 'b', 'private']) await writeFile(join(directory, resource(label).descriptor.path), resource(label).data);
    await writeFile(join(directory, 'frame-capture.json'), JSON.stringify({ version: 1, viewport: { width: 960, height: 720 },
      stages: ['before', 'changed', 'scrolled', 'removed'].map((name, index) => ({ name, frame: scene(index + 1, index >= 2 ? 'b' : 'a') })) }));
    await writeFile(join(directory, 'frame-trace.json'), '{"private":"trace"}');
    const base = await lab.listen();
    const post = (path, body, origin = base) => fetch(base + path, { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/session', {}, 'https://external.example')).status, 403);
    const { epoch } = await (await post('/api/session', {})).json();
    const offer = async stage => (await fetch(`${base}/api/frame?epoch=${epoch}&stage=${stage}`)).json();
    const first = (await offer('before')).packet, second = (await offer('changed')).packet;
    assert.equal(first.resources.length, 1); assert.equal(second.resources.length, 1);
    assert.equal((await offer('scrolled')).status, 'queued'); assert.equal((await offer('removed')).status, 'queued');
    assert.equal((await post('/api/ack', { ...ack(second), seq: 99 })).status, 400);
    const accepted = await (await post('/api/ack', ack(second))).json();
    assert.equal(accepted.accepted, true); assert.equal(accepted.packet.frame.native.ts, 4);
    assert.equal(accepted.channel.pending, 1); assert.equal(accepted.channel.coalesced, 1);
    assert.equal((await (await post('/api/ack', ack(first))).json()).accepted, false);
    assert.equal((await fetch(base + '/' + resource('private').descriptor.path)).status, 404);
    assert.equal((await fetch(base + '/frame-trace.json')).status, 404);
    const data = await fetch(base + '/' + resource('b').descriptor.path);
    assert.deepEqual(Buffer.from(await data.arrayBuffer()), resource('b').data);
    assert.equal((await post('/api/ack', ack(accepted.packet))).status, 200);
    assert.equal(lab.stats.acknowledgements, 2); assert.equal(lab.stats.resourceRequests, 1);
    assert.equal(lab.stats.sessions[0].pending, 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
