import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadReplayRuntime } from './runtime.js';
import { FrameChannel, validateFrame } from './frame-protocol.js';

const assets = new Map([
  ['/', ['frame-index.html', 'text/html; charset=utf-8']],
  ...['frame-replay.js', 'frame-protocol.js', 'frame-renderer.js', 'font-runtime.js', 'frames.js'].map(name => ['/' + name, [name, 'text/javascript; charset=utf-8']]),
  ...['frames.css', 'lab.css'].map(name => ['/' + name, [name, 'text/css; charset=utf-8']]),
  ['/frames.html', ['frames.html', 'text/html; charset=utf-8']],
  ['/fonts/fixture-sans.otf', ['fonts/fixture-sans.otf', 'font/otf']],
]);

async function jsonBody(request) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('JSON required');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    if ((bytes += chunk.length) > 65536) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// A bounded, loopback-only experimental transport. It never decodes SKPs or
// creates pixels. This is not the production worker/session gateway.
export function createFrameLab({ outputDir, canvasKitDirectory }) {
  const directory = resolve(outputDir), sessions = new Map();
  let runtime, baseUrl;
  const stats = { resourceRequests: 0, resourceBytes: 0, acknowledgements: 0 };
  async function capture() {
    const manifest = JSON.parse(await readFile(join(directory, 'frame-capture.json'), 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.stages) || manifest.stages.length > 64) throw new Error('Unsupported frame capture');
    for (const stage of manifest.stages) validateFrame(stage.frame);
    return manifest;
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      if (request.headers.host !== new URL(baseUrl).host || !['GET', 'POST'].includes(request.method)) return json(403, { error: 'Local requests only' });
      const url = new URL(request.url, baseUrl), path = url.pathname;
      if (request.method === 'POST') {
        if (request.headers.origin !== baseUrl) return json(403, { error: 'Same-origin POST required' });
        const body = await jsonBody(request);
        if (path === '/api/session') {
          if (sessions.size >= 4) sessions.delete(sessions.keys().next().value);
          const epoch = randomUUID(); sessions.set(epoch, new FrameChannel(epoch));
          return json(200, { epoch });
        }
        if (path === '/api/ack') {
          const channel = sessions.get(body.epoch);
          if (!channel) return json(410, { error: 'Frame session expired' });
          const result = channel.acknowledge(body);
          if (result.accepted) stats.acknowledgements++;
          return json(200, { ...result, channel: channel.state });
        }
        return json(404, { error: 'Unknown POST route' });
      }
      if (path === '/runtime.json') return json(200, runtime.metadata);
      if (path === '/api/capture') {
        const manifest = await capture();
        return json(200, { version: 1, viewport: manifest.viewport, browser: manifest.browser,
          stages: manifest.stages.map(stage => ({ name: stage.name, frameId: stage.frame.id })) });
      }
      if (path === '/api/frame' || path === '/api/stats') {
        const channel = sessions.get(url.searchParams.get('epoch'));
        if (!channel) return json(410, { error: 'Frame session expired' });
        if (path === '/api/stats') return json(200, { ...stats, channel: channel.state });
        const manifest = await capture(), stage = manifest.stages.find(stage => stage.name === url.searchParams.get('stage'));
        if (!stage) return json(404, { error: 'Unknown capture stage' });
        return json(200, channel.offer(stage.frame));
      }
      let bytes, type;
      if (path === '/canvaskit.js' || path === '/canvaskit.wasm') {
        bytes = runtime.assets.get(path.slice(1)); type = path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8';
      } else if (assets.has(path)) {
        const asset = assets.get(path); bytes = await readFile(new URL(asset[0], import.meta.url)); type = asset[1];
      } else if (/^\/(pictures\/[a-f0-9]{64}\.skp|fonts\/[a-f0-9]{64}\.font|images\/[a-f0-9]{64}\.img)$/.test(path)) {
        const manifest = await capture(), descriptor = manifest.stages.flatMap(stage => stage.frame.resources).find(resource => '/' + resource.path === path);
        if (!descriptor) return json(404, { error: 'Unknown frame resource' });
        bytes = await readFile(join(directory, descriptor.path)); type = 'application/octet-stream';
        stats.resourceRequests++; stats.resourceBytes += bytes.length;
      } else return json(404, { error: 'Unknown route' });
      response.writeHead(200, { 'Content-Type': type }); response.end(bytes);
    } catch (error) { json(error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? 'Frame capture not available' : error.message }); }
  });
  return {
    async listen(port = 0) {
      runtime = await loadReplayRuntime(canvasKitDirectory);
      await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
      baseUrl = `http://127.0.0.1:${server.address().port}`; return baseUrl;
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections(); await new Promise(done => server.close(done));
      runtime?.close?.();
    },
    get stats() { return { ...stats, sessions: [...sessions.values()].map(channel => channel.state) }; },
  };
}
