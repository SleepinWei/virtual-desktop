import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { fixture, actionPayload } from './helpers.js';
import { AgentClient } from '../src/client.js';
import { applyFrame } from '../src/protocol.js';

const path = (session, operation) => `/api/sessions/${session.id}/${operation}`;

test('agent works without a viewer, and frames contain drawable commands', async t => {
  const f = await fixture(t), s = await f.create(), agent = new AgentClient(f.baseUrl, s);
  await agent.fill('#task-input', 'No viewer is needed');
  await agent.click('#add-task');
  await agent.click('#increment');
  const observation = await agent.observe();
  assert.match(observation.text, /No viewer is needed/);
  const snapshot = await f.request(path(s, 'frame'), s.viewerToken);
  assert.equal(snapshot.data.type, 'snapshot');
  assert.ok(snapshot.data.commands.some(command => command.text === '1'));
  const metrics = await f.request(path(s, 'metrics'));
  assert.notEqual(metrics.data.pid, process.pid);
  assert.equal(metrics.data.runtime, 'linkedom-yoga-poc');
  assert.equal(metrics.data.pixelBackend, null);
});

test('read-only capability, cross-session access and management capabilities are enforced', async t => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  assert.equal((await f.request(path(a, 'observe'), b.viewerToken)).status, 403);
  assert.equal((await f.request(path(a, 'actions'), a.viewerToken, 'POST', actionPayload(1, { type: 'click', selector: '#increment' }))).status, 403);
  assert.equal((await f.request(path(a, 'control'), a.agentToken, 'POST', { epoch: 1, owner: 'human' })).status, 403);
  assert.equal((await f.request(path(a, 'release'), a.agentToken, 'POST', { save: false })).status, 403);
  assert.equal((await f.request('/api/sessions', a.viewerToken)).status, 403);
  await new AgentClient(f.baseUrl, a).click('#increment');
  const frame = await f.request(path(b, 'frame'), b.viewerToken);
  assert.ok(frame.data.commands.some(command => command.text === '0'));
});

test('takeover fences stale writers and requires fresh agent epoch after return', async t => {
  const f = await fixture(t), s = await f.create(), agent = new AgentClient(f.baseUrl, s);
  const acquire = await f.request(path(s, 'control'), s.humanToken, 'POST', { epoch: 1, owner: 'human' });
  assert.equal(acquire.data.epoch, 2);
  await assert.rejects(() => agent.click('#increment'), error => error.code === 'CONTROL_LOST');
  assert.equal((await f.request(path(s, 'actions'), s.humanToken, 'POST', actionPayload(2, { type: 'click', selector: '#increment' }))).status, 200);
  const release = await f.request(path(s, 'control'), s.humanToken, 'POST', { epoch: 2, owner: 'agent' });
  assert.equal(release.data.epoch, 3);
  await assert.rejects(() => agent.click('#increment'), error => error.code === 'CONTROL_LOST');
  await agent.observe();
  await agent.click('#increment');
  assert.equal((await f.request(path(s, 'control'), s.humanToken, 'POST', { epoch: 2, owner: 'human' })).status, 409);
});

test('actions deduplicate, conflicting ids and clicks on stale displayed frames are rejected', async t => {
  const f = await fixture(t), s = await f.create();
  const payload = actionPayload(1, { type: 'click', selector: '#increment' }, 'once');
  assert.equal((await f.request(path(s, 'actions'), s.agentToken, 'POST', payload)).data.deduplicated, false);
  assert.equal((await f.request(path(s, 'actions'), s.agentToken, 'POST', payload)).data.deduplicated, true);
  const conflict = await f.request(path(s, 'actions'), s.agentToken, 'POST', { ...payload, action: { type: 'click', selector: '#add-task' } });
  assert.equal(conflict.data.error.code, 'ACTION_ID_REUSED');
  const stale = await f.request(path(s, 'actions'), s.agentToken, 'POST', actionPayload(1, { type: 'pointer', x: 60, y: 400, seq: 1 }));
  assert.equal(stale.data.error.code, 'STALE_FRAME');
  const snapshot = await f.request(path(s, 'frame'), s.viewerToken);
  assert.ok(snapshot.data.commands.some(command => command.text === '1'));
});

test('delta, reconnect snapshot and unchanged responses follow sequence semantics', async t => {
  const f = await fixture(t), s = await f.create(), agent = new AgentClient(f.baseUrl, s);
  const initial = (await f.request(path(s, 'frame'), s.viewerToken)).data;
  await agent.click('#increment');
  const delta = (await f.request(`${path(s, 'frame')}?since=1`, s.viewerToken)).data;
  const current = (await f.request(path(s, 'frame'), s.viewerToken)).data;
  // HTTP adds routing/control metadata outside the wire scene.
  const { sessionId, control, type, ...expected } = current;
  assert.deepEqual(applyFrame(initial, delta), expected);
  assert.ok(JSON.stringify(delta).length < JSON.stringify(current).length);
  assert.equal((await f.request(`${path(s, 'frame')}?since=2`, s.viewerToken)).data.type, 'unchanged');
  await agent.click('#increment');
  assert.equal((await f.request(`${path(s, 'frame')}?since=1`, s.viewerToken)).data.type, 'snapshot');
});

test('profile single-writer, atomic save and cold restore keep application state', async t => {
  const f = await fixture(t), s = await f.create({ profileId: 'saved-profile' });
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { profileId: s.profileId })).status, 409);
  const agent = new AgentClient(f.baseUrl, s);
  await agent.fill('#task-input', 'Saved draft');
  await agent.click('#increment');
  const pid = (await f.request(path(s, 'metrics'))).data.pid;
  assert.equal((await f.request(path(s, 'release'), 'test-admin', 'POST', { save: true })).data.state, 'COLD');
  assert.equal(f.service.manager.stats().active, 0);
  const disk = JSON.parse(await readFile(join(f.dataDir, `${s.profileId}.json`), 'utf8'));
  assert.equal(disk.state.count, 1);
  const restored = await f.create({ profileId: s.profileId });
  assert.notEqual((await f.request(path(restored, 'metrics'))).data.pid, pid);
  const frame = (await f.request(path(restored, 'frame'), restored.viewerToken)).data;
  assert.ok(frame.commands.some(command => command.text === '1'));
  assert.equal(frame.targets.find(target => target.selector === '#task-input').value, 'Saved draft');
});

test('bounded admission queues new sessions and releases a slot after close', async t => {
  const f = await fixture(t, { maxActive: 1, maxQueued: 1, maxStarting: 1 });
  const a = await f.create();
  const waiting = f.request('/api/sessions', 'test-admin', 'POST', { profileId: 'waiting' });
  while (!f.service.manager.stats().queued) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { profileId: 'excess' })).status, 429);
  await f.request(path(a, 'release'), 'test-admin', 'POST', { save: false });
  assert.equal((await waiting).status, 201);
  assert.equal(f.service.manager.stats().active, 1);
});

test('queue timeout releases profile lock', async t => {
  const f = await fixture(t, { maxActive: 1, queueTimeoutMs: 80 });
  await f.create();
  const result = await f.request('/api/sessions', 'test-admin', 'POST', { profileId: 'timeout-profile' });
  assert.equal(result.data.error.code, 'QUEUE_TIMEOUT');
  assert.equal(f.service.manager.profileLocks.has('timeout-profile'), false);
});

test('worker crash releases capacity and does not replay actions', async t => {
  const f = await fixture(t, { maxActive: 1 }), s = await f.create();
  const worker = f.service.manager.get(s.id).worker;
  worker.child.kill('SIGKILL');
  await worker.exited;
  assert.equal(f.service.manager.get(s.id).state, 'FAILED');
  assert.equal(f.service.manager.stats().active, 0);
  assert.equal((await f.request(path(s, 'observe'), s.agentToken)).status, 409);
  const replacement = await f.create({ profileId: s.profileId });
  assert.equal(replacement.state, 'ACTIVE');
});

test('invalid payloads and corrupted profiles fail without leaking an execution slot', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { profileId: '../escape' })).status, 400);
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { viewport: { width: 0, height: 720 } })).status, 400);
  await writeFile(join(f.dataDir, 'bad.json'), '{broken');
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { profileId: 'bad' })).status, 500);
  assert.equal(f.service.manager.stats().active, 0);
  const s = await f.create();
  assert.equal((await f.request(path(s, 'actions'), s.agentToken, 'POST', actionPayload(1, { type: 'fill', selector: '#task-input', value: 'x'.repeat(201) }))).status, 400);
  const raw = await fetch(`${f.baseUrl}/api/sessions`, { method: 'POST', headers: { Authorization: 'Bearer test-admin' }, body: '{broken' });
  assert.equal(raw.status, 400);
});

test('failed save preserves prior profile and leaves the live session usable', async t => {
  const f = await fixture(t), original = await f.create({ profileId: 'save-failure' });
  await new AgentClient(f.baseUrl, original).click('#increment');
  await f.request(path(original, 'release'), 'test-admin', 'POST', { save: true });
  const s = await f.create({ profileId: original.profileId });
  const worker = f.service.manager.get(s.id).worker;
  const call = worker.call.bind(worker);
  worker.call = (method, params) => {
    if (method === 'save') return Promise.reject(new Error('Injected persistence failure'));
    return call(method, params);
  };
  assert.equal((await f.request(path(s, 'release'), 'test-admin', 'POST', { save: true })).status, 500);
  assert.equal(f.service.manager.get(s.id).state, 'ACTIVE');
  assert.equal(JSON.parse(await readFile(join(f.dataDir, `${s.profileId}.json`), 'utf8')).state.count, 1);
  await new AgentClient(f.baseUrl, s).click('#increment');
});

test('non-local Host and cross-origin browser requests are rejected', async t => {
  const f = await fixture(t);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(f.baseUrl + '/health', { headers: { Host: 'example.com' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.once('error', reject);
  });
  assert.equal(hostStatus, 403);
  const origin = await fetch(f.baseUrl + '/api/sessions', { headers: { Authorization: 'Bearer test-admin', Origin: 'https://example.com' } });
  assert.equal(origin.status, 403);
});
