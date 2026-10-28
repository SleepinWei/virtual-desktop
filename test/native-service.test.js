import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { readFile } from 'node:fs/promises';

test('native mode is explicit and cannot silently launch an installed browser or reuse the v0 frame protocol', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { backend: 'chromium' })).data.error.code, 'NATIVE_NOT_CONFIGURED');
  assert.equal((await f.request('/api/sessions', 'test-admin', 'POST', { backend: 'unknown' })).data.error.code, 'INVALID_BACKEND');
  assert.equal((await fetch(f.baseUrl + '/native')).status, 200);
  assert.equal((await fetch(f.baseUrl + '/native-runtime/canvaskit.wasm')).status, 503);
  const session = await f.create();
  assert.equal((await f.request(`/api/sessions/${session.id}/frames/connect`, session.viewerToken, 'POST', {})).data.error.code, 'NATIVE_STREAM_REQUIRED');
});

test('native backend never uses pixel readback APIs or reconstructs drawing from page geometry', async () => {
  for (const name of ['session.js', 'worker.js', 'native-stream.js']) {
    const source = await readFile(new URL('../experiments/chromium-engine/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.screenshot\s*\(|captureScreenshot|startScreencast|toDataURL|createCanvas|getBoundingClientRect|boundingBox/);
  }
});
