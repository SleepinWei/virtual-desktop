import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadReplayRuntime } from './runtime.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/replay.js', ['replay.js', 'text/javascript; charset=utf-8']],
  ['/lab.css', ['lab.css', 'text/css; charset=utf-8']],
  ['/fixture.html', ['fixture.html', 'text/html; charset=utf-8']],
  ['/fixture.css', ['fixture.css', 'text/css; charset=utf-8']],
  ['/fixture.js', ['fixture.js', 'text/javascript; charset=utf-8']],
  ['/fonts/fixture-sans.otf', ['fonts/fixture-sans.otf', 'font/otf']],
]);

// Separate from the v0 gateway: this lab serves a trusted fixture and captured SKPs.
// It does not execute CanvasKit, decode pictures or generate pixels on the server.
export function createPaintLab({ outputDir, canvasKitDirectory }) {
  const root = resolve(outputDir);
  let runtime;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (request.method !== 'GET' || !/^(127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.host || '')) {
        response.writeHead(403); response.end('Local GET requests only'); return;
      }
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/runtime.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(runtime.metadata)); return;
      }
      if (path === '/canvaskit.js' || path === '/canvaskit.wasm') {
        response.writeHead(200, { 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8' });
        response.end(runtime.assets.get(path.slice(1))); return;
      }
      let file, type;
      if (assets.has(path)) {
        const asset = assets.get(path);
        file = new URL(asset[0], import.meta.url); type = asset[1];
      } else if (path === '/capture.json') {
        file = join(root, 'capture.json'); type = 'application/json';
      } else if (path.startsWith('/pictures/')) {
        const manifest = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
        const allowed = manifest.stages.flatMap(stage => stage.pictures).map(picture => picture.path);
        const relative = path.slice(1);
        if (!allowed.includes(relative) || relative.includes('..') || !/^pictures\/[a-zA-Z0-9._-]+\.skp$/.test(relative)) {
          response.writeHead(404); response.end('Unknown picture'); return;
        }
        file = join(root, relative); type = 'application/octet-stream';
      } else {
        response.writeHead(404); response.end('Not found'); return;
      }
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': type }); response.end(content);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      response.end(error.code === 'ENOENT' ? 'Capture not available yet' : 'Paint lab error');
    }
  });
  return {
    async listen(port = 0) {
      runtime = await loadReplayRuntime(canvasKitDirectory);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}
