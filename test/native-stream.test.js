import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { JsonLines, authenticateNativeMessage, createNativeStream } from '../experiments/chromium-engine/native-stream.js';

test('native framing handles fragmented UTF-8 and multiple messages without publishing partial records', () => {
  const messages = [], decoder = new JsonLines(value => messages.push(value));
  const first = Buffer.from(JSON.stringify({ text: '中文', frame: 1 }) + '\n');
  for (const byte of first.subarray(0, first.length - 1)) decoder.push(Buffer.from([byte]));
  assert.deepEqual(messages, []);
  decoder.push(Buffer.concat([first.subarray(-1), Buffer.from('{"frame":2}\n')]));
  assert.deepEqual(messages, [{ text: '中文', frame: 1 }, { frame: 2 }]);
  assert.throws(() => new JsonLines(() => {}, 8).push(Buffer.alloc(9)), /exceeds/);
});

test('native capabilities and producer identity are validated and the secret is removed', () => {
  const token = 'a'.repeat(64), message = { version: 1, token, pid: 123, ts: 456, snapshot: {} };
  assert.equal(Object.hasOwn(authenticateNativeMessage(message, token), 'token'), false);
  assert.throws(() => authenticateNativeMessage({ ...message, token: 'b'.repeat(64) }, token), /capability/);
  assert.throws(() => authenticateNativeMessage({ ...message, pid: -1 }, token), /identity/);
});

test('private native socket rejects an unrelated sender and accepts complete authenticated records', async () => {
  let received;
  const done = new Promise(resolve => { received = resolve; });
  const stream = await createNativeStream(received), environment = stream.environment;
  const path = environment.VIRTUAL_DESKTOP_REMOTE_PAINT_SOCKET;
  try {
    const bad = net.connect(path); await new Promise(resolve => bad.once('connect', resolve));
    bad.write(JSON.stringify({ version: 1, token: 'invalid', pid: 1, ts: 1 }) + '\n');
    await new Promise(resolve => bad.once('close', resolve));
    const socket = net.connect(path); await new Promise(resolve => socket.once('connect', resolve));
    socket.write(JSON.stringify({ version: 1, token: environment.VIRTUAL_DESKTOP_REMOTE_PAINT_TOKEN, pid: 123, ts: 456, snapshot: { supported: true } }) + '\n');
    assert.deepEqual(await done, { version: 1, pid: 123, ts: 456, snapshot: { supported: true } });
    assert.equal(stream.stats.rejected, 1); assert.equal(stream.stats.messages, 1); socket.destroy();
  } finally { await stream.close(); }
});
