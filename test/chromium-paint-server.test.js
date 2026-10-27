import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createPaintLab } from '../experiments/chromium-paint/server.js';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('paint lab only serves loopback GET assets and manifest-listed SKPs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chromium-paint-test-'));
  const lab = createPaintLab({ outputDir: directory });
  try {
    await mkdir(join(directory, 'pictures'));
    const picture = Buffer.from('skiapict-test');
    await writeFile(join(directory, 'pictures/known.skp'), picture);
    await writeFile(join(directory, 'pictures/private.skp'), picture);
    await writeFile(join(directory, 'trace.json'), '{"sensitive":"raw trace"}');
    await writeFile(join(directory, 'capture.json'), JSON.stringify({ stages: [{ pictures: [{ path: 'pictures/known.skp' }] }] }));
    const base = await lab.listen();
    const response = await request(base + '/pictures/known.skp');
    assert.equal(response.status, 200); assert.deepEqual(response.body, picture);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal((await request(base + '/pictures/private.skp')).status, 404);
    assert.equal((await request(base + '/trace.json')).status, 404);
    assert.equal((await request(base + '/pictures/%2e%2e/trace.json')).status, 404);
    assert.equal((await request(base + '/', { headers: { Host: 'external.example' } })).status, 403);
    assert.equal((await request(base + '/', { method: 'POST' })).status, 403);
    assert.equal((await request(base + '/fixture.html')).status, 200);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});
