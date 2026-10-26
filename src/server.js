import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SessionManager, sameToken } from './sessions.js';
import { AppError, ensure } from './errors.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/protocol.js', ['../src/protocol.js', 'text/javascript; charset=utf-8']],
]);
async function body(request) {
  let bytes = 0, result = '';
  for await (const chunk of request) {
    bytes += chunk.length;
    ensure(bytes <= 16384, 413, 'BODY_TOO_LARGE', 'Request is limited to 16 KiB');
    result += chunk;
  }
  if (!result) return {};
  try {
    const parsed = JSON.parse(result);
    ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'INVALID_JSON', 'Expected a JSON object');
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_JSON', 'Invalid JSON');
  }
}

export function createService({ adminToken = 'dev-local', ...options } = {}) {
  const manager = new SessionManager(options);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, result) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(result)); };
    try {
      ensure(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(request.headers.host || ''), 403, 'INVALID_HOST', 'Only local hostnames are permitted');
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') { json(200, { ok: true, runtime: 'linkedom-yoga-poc', protocolVersion: 1 }); return; }
      const credential = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const admin = () => ensure(sameToken(credential, adminToken), 403, 'FORBIDDEN', 'Management capability required');
      // Browser calls must originate from this local app. CLI clients need no Origin.
      if (request.headers.origin) ensure(request.headers.origin === `http://${request.headers.host}`, 403, 'INVALID_ORIGIN', 'Cross-origin requests are forbidden');
      if (url.pathname === '/api/sessions' && request.method === 'POST') { admin(); json(201, await manager.create(await body(request))); return; }
      if (url.pathname === '/api/sessions' && request.method === 'GET') { admin(); json(200, { sessions: [...manager.sessions.values()].map(s => manager.public(s)), stats: manager.stats() }); return; }
      const match = /^\/api\/sessions\/([a-f0-9-]{36})\/(observe|frame|actions|control|release|metrics)$/.exec(url.pathname);
      ensure(match, 404, 'NOT_FOUND', 'Route not found');
      const [, id, operation] = match;
      if (request.method === 'GET' && ['observe', 'frame'].includes(operation)) {
        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
        ensure(since === undefined || Number.isSafeInteger(since) && since >= 0, 400, 'INVALID_SEQUENCE', 'Invalid frame sequence');
        json(200, await manager.read(id, credential, operation, { since })); return;
      }
      if (request.method === 'GET' && operation === 'metrics') { admin(); const s = manager.get(id); manager.active(s); json(200, await s.worker.call('metrics')); return; }
      if (request.method === 'POST' && operation === 'actions') { json(200, await manager.action(id, credential, await body(request))); return; }
      if (request.method === 'POST' && operation === 'control') { json(200, await manager.control(id, credential, await body(request))); return; }
      if (request.method === 'POST' && operation === 'release') { admin(); json(200, await manager.release(id, await body(request))); return; }
      throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      json(error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : 'Internal service error' } });
    }
  });
  server.requestTimeout = 30000;
  return {
    server, manager,
    async listen(port = 8080, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    },
    async close() {
      server.closeAllConnections();
      await manager.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  ensure(['127.0.0.1', 'localhost', '::1'].includes(host), 500, 'LOCAL_ONLY', 'v0 only permits loopback binding');
  const service = createService({
    adminToken: process.env.ADMIN_TOKEN || 'dev-local', dataDir: process.env.DATA_DIR || '.data',
    maxActive: Number(process.env.MAX_ACTIVE || 8), maxQueued: Number(process.env.MAX_QUEUED || 16), maxStarting: Number(process.env.MAX_STARTING || 2),
  });
  const address = await service.listen(Number(process.env.PORT || 8080), host);
  console.log(`virtual-desktop v0: ${address} (local experiment; no server pixel renderer)`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
