import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SessionManager, sameToken } from './sessions.js';
import { AppError, ensure } from './errors.js';
import { nativeAssets, nativeFixtures, nativeAllowedPaths } from '../experiments/chromium-engine/assets.js';
import { verifiedEngine } from '../experiments/chromium-engine/verified.js';
import { externalSites } from '../experiments/chromium-engine/sites.js';
import { loadReplayRuntime, verifyRuntimeBuild } from '../experiments/chromium-paint/runtime.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/protocol.js', ['../src/protocol.js', 'text/javascript; charset=utf-8']],
]);
async function body(request, maxBytes = 16384) {
  let bytes = 0, result = '';
  for await (const chunk of request) {
    bytes += chunk.length;
    ensure(bytes <= maxBytes, 413, 'BODY_TOO_LARGE', 'Request exceeds the local body limit');
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

export function createService({ adminToken = 'dev-local', chromium: nativeOptions, ...options } = {}) {
  const manager = new SessionManager(options);
  let replayRuntime, nativeEngine;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${nativeOptions ? " 'wasm-unsafe-eval'" : ''}; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    const json = (status, result) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(result)); };
    try {
      ensure(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(request.headers.host || ''), 403, 'INVALID_HOST', 'Only local hostnames are permitted');
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && (nativeAssets.has(url.pathname) || nativeEngine && nativeFixtures.has(url.pathname))) {
        const asset = nativeAssets.get(url.pathname) || nativeFixtures.get(url.pathname);
        response.writeHead(200, { 'Content-Type': asset.type }); response.end(await readFile(asset.file)); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/native-runtime/')) {
        ensure(replayRuntime, 503, 'NATIVE_NOT_CONFIGURED', 'A verified native runtime is not configured');
        const name = url.pathname.slice('/native-runtime/'.length);
        if (name === 'runtime.json') { json(200, replayRuntime.metadata); return; }
        const fontId = /^fonts\/([a-f0-9]{64})\.font$/.exec(name)?.[1];
        if (fontId) {
          const font = replayRuntime.fonts?.get(fontId);
          ensure(font, 404, 'NOT_FOUND', 'Unknown runtime font asset');
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': font.length,
            'Cache-Control': 'public, max-age=31536000, immutable' });
          const stream = font.stream(); response.once('close', () => stream.destroy());
          stream.on('error', error => response.destroy(error)).pipe(response); return;
        }
        ensure(['canvaskit.js', 'canvaskit.wasm'].includes(name), 404, 'NOT_FOUND', 'Unknown runtime asset');
        response.writeHead(200, { 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8' });
        response.end(replayRuntime.assets.get(name)); return;
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') { json(200, { ok: true, runtime: 'linkedom-yoga-poc', protocolVersion: 1,
        ...(nativeEngine ? { nativeAvailable: true, nativeProtocolVersion: 1, engineSplitGate: 'not-passed',
          externalTargets: nativeOptions.externalSites ? Object.keys(externalSites).filter(site => externalSites[site].interactive !== false) : [],
          externalUrls: nativeOptions.externalSites ? Object.fromEntries(Object.entries(externalSites).map(([id, site]) => [id, site.url])) : {},
          urlPreview: { enabled: Boolean(nativeOptions.externalSites), domains: nativeOptions.externalSites
            ? [...new Set(Object.values(externalSites).flatMap(site => site.navigationDomains))] : [] },
          ...(nativeOptions.resourceStatus ? { nativeResources: nativeOptions.resourceStatus() } : {}) } : {}) }); return; }
      const credential = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const admin = () => ensure(sameToken(credential, adminToken), 403, 'FORBIDDEN', 'Management capability required');
      // Browser calls must originate from this local app. CLI clients need no Origin.
      if (request.headers.origin) ensure(request.headers.origin === `http://${request.headers.host}`, 403, 'INVALID_ORIGIN', 'Cross-origin requests are forbidden');
      if (url.pathname === '/api/sessions' && request.method === 'POST') { admin(); json(201, await manager.create(await body(request))); return; }
      if (url.pathname === '/api/sessions' && request.method === 'GET') { admin(); json(200, { sessions: [...manager.sessions.values()].map(s => manager.public(s)), stats: manager.stats() }); return; }
      if (url.pathname === '/api/native/targets/resolve' && request.method === 'POST') {
        admin(); json(200, manager.resolveNativeUrl((await body(request)).url)); return;
      }
      const nativeMatch = /^\/api\/sessions\/([a-f0-9-]{36})\/frames\/(connect|stream|ack|disconnect|resources\/([a-f0-9]{64}))$/.exec(url.pathname);
      if (nativeMatch) {
        const [, id, operation, resourceId] = nativeMatch, { frames, role } = manager.native(id, credential);
        if (request.method === 'POST' && operation === 'connect') {
          const input = await body(request);
          if (input.previousEpoch) frames.disconnect(frames.get(input.previousEpoch, role).epoch);
          json(201, frames.connect(role)); return;
        }
        if (request.method === 'POST' && operation === 'ack') { json(200, frames.acknowledge(await body(request, 131072), role)); return; }
        if (request.method === 'POST' && operation === 'disconnect') {
          const input = await body(request); frames.disconnect(frames.get(input.epoch, role).epoch); json(200, { disconnected: true }); return;
        }
        if (request.method === 'GET' && resourceId) {
          const bytes = frames.resource(url.searchParams.get('epoch'), role, resourceId);
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
          if (Buffer.isBuffer(bytes)) response.end(bytes);
          else {
            const stream = bytes.stream();
            response.once('close', () => stream.destroy());
            stream.on('error', error => response.destroy(error)).pipe(response);
          }
          return;
        }
        if (request.method === 'GET' && operation === 'stream') {
          const epoch = url.searchParams.get('epoch'), connection = frames.get(epoch, role);
          ensure(!connection.send, 409, 'FRAME_CONNECTION_BUSY', 'Frame stream is already attached');
          let blocked = false, ended = false, queuedControl = null;
          const queue = [];
          const write = message => { blocked = !response.write(JSON.stringify(message) + '\n'); };
          const send = message => {
            if (ended) return;
            if (message.kind === 'unsupported') { queue.length = 0; queuedControl = null; response.end(JSON.stringify(message) + '\n'); ended = true; return; }
            if (blocked) {
              if (message.kind === 'control') queuedControl = message;
              else { ensure(queue.length < 2, 500, 'FRAME_OUTBOX_FULL', 'Native stream backpressure limit exceeded'); queue.push(message); }
            } else write(message);
          };
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          response.setTimeout(0);
          response.on('drain', () => {
            if (ended || response.destroyed) return;
            blocked = false;
            while (!blocked && queue.length) write(queue.shift());
            if (!blocked && queuedControl) { const message = queuedControl; queuedControl = null; write(message); }
          });
          response.on('error', () => response.destroy());
          const detach = frames.attach(epoch, role, send, () => { ended = true; queue.length = 0; queuedControl = null; response.end(); });
          const heartbeat = setInterval(() => { if (!blocked && !ended) write({ kind: 'ping' }); }, 10000); heartbeat.unref();
          response.once('close', () => { ended = true; clearInterval(heartbeat); detach(); });
          return;
        }
        throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Unsupported native stream method');
      }
      const match = /^\/api\/sessions\/([a-f0-9-]{36})\/(observe|frame|actions|control|release|metrics)$/.exec(url.pathname);
      ensure(match, 404, 'NOT_FOUND', 'Route not found');
      const [, id, operation] = match;
      if (request.method === 'GET' && ['observe', 'frame'].includes(operation)) {
        const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
        ensure(since === undefined || Number.isSafeInteger(since) && since >= 0, 400, 'INVALID_SEQUENCE', 'Invalid frame sequence');
        json(200, await manager.read(id, credential, operation, { since })); return;
      }
      if (request.method === 'GET' && operation === 'metrics') { admin(); const s = manager.get(id); manager.active(s);
        json(200, { ...await s.worker.call('metrics'), ...(s.frames ? { frames: s.frames.stats } : {}) }); return; }
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
      if (nativeOptions) {
        ensure(process.platform !== 'win32' && nativeOptions.canvasKitDirectory, 500, 'INVALID_NATIVE_CONFIG', 'Native stream requires POSIX and a matching CanvasKit build');
        nativeEngine = await verifiedEngine(nativeOptions.root, { requireStream: true });
        replayRuntime = await loadReplayRuntime(nativeOptions.canvasKitDirectory);
        ensure(replayRuntime.metadata.skiaRevision === nativeEngine.source.skiaRevision, 500, 'INVALID_NATIVE_RUNTIME', 'CanvasKit must match the Chromium Skia revision');
        await verifyRuntimeBuild(replayRuntime, nativeOptions.canvasKitDirectory, nativeEngine.root, nativeEngine.source);
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
      if (nativeEngine) manager.nativeConfig = { baseUrl, maxSessions: nativeOptions.maxSessions || 2, externalSites: Boolean(nativeOptions.externalSites), worker: {
        root: nativeEngine.root, expectedArtifactsSha256: nativeEngine.artifactsSha256,
        expectedPatchSha256: nativeEngine.patchSha256, allowedPaths: nativeAllowedPaths } };
      return baseUrl;
    },
    async close() {
      if (server.listening) server.closeAllConnections();
      await manager.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      replayRuntime?.close?.();
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
