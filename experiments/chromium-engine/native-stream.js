import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, chmod, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const MAX_NATIVE_MESSAGE = 8 * 1024 * 1024;
const temporaryRoot = () => process.platform === 'darwin' ? '/private/tmp' : tmpdir();
export function nativeStreamDirectory(value, pid) {
  return typeof value === 'string' && value === resolve(value) && dirname(value) === resolve(temporaryRoot()) &&
    Number.isSafeInteger(pid) && pid > 0 && new RegExp(`^vd-native-${pid}-[a-zA-Z0-9]{6}$`).test(basename(value));
}
export async function cleanupNativeDirectories(pids) {
  const owners = new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0));
  let removed = 0;
  for (const entry of await readdir(temporaryRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pid = Number(/^vd-native-(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name)?.[1]);
    const path = join(temporaryRoot(), entry.name);
    if (owners.has(pid) && nativeStreamDirectory(path, pid)) { await rm(path, { recursive: true, force: true }); removed++; }
  }
  return removed;
}

export class JsonLines {
  constructor(consume, limit = MAX_NATIVE_MESSAGE) { this.consume = consume; this.limit = limit; this.parts = []; this.bytes = 0; }
  push(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if ((this.bytes += part.length) > this.limit) throw new Error('Native message exceeds limit');
      if (part.length) this.parts.push(part);
      if (newline < 0) return;
      if (!this.bytes) throw new Error('Empty native message');
      const text = Buffer.concat(this.parts, this.bytes).toString('utf8');
      this.parts = []; this.bytes = 0;
      this.consume(JSON.parse(text));
      start = end + 1;
    }
  }
}

export function authenticateNativeMessage(message, token) {
  const actual = typeof message?.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0), expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid native producer capability');
  if (message.version !== 1 || !Number.isSafeInteger(message.pid) || message.pid <= 0 || !Number.isSafeInteger(message.ts) || message.ts < 0) throw new Error('Invalid native producer identity');
  const { token: ignored, ...safe } = message;
  return safe;
}

// One private endpoint per browser worker; no pixels and no trace transport.
export async function createNativeStream(consume) {
  // macOS's per-user tmpdir is too long for sockaddr_un.sun_path. Other
  // POSIX hosts (including Linux CI) do not necessarily have /private/tmp.
  const directory = await mkdtemp(join(temporaryRoot(), `vd-native-${process.pid}-`));
  await chmod(directory, 0o700);
  const fonts = join(directory, 'fonts');
  await mkdir(fonts, { mode: 0o700 });
  const images = join(directory, 'images');
  await mkdir(images, { mode: 0o700 });
  const path = join(directory, 'paint.sock'), token = randomBytes(32).toString('hex'), sockets = new Set();
  const stats = { messages: 0, rejected: 0, connections: 0, maxBufferedBytes: 0 };
  const server = net.createServer(socket => {
    if (sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket); stats.connections++;
    socket.setTimeout(5000, () => socket.destroy());
    const decoder = new JsonLines(message => {
      const safe = authenticateNativeMessage(message, token);
      socket.setTimeout(0); stats.messages++; consume(safe);
    });
    socket.on('data', chunk => {
      try { decoder.push(chunk); stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, decoder.bytes); }
      catch { stats.rejected++; socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(path, done); });
    await chmod(path, 0o600);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    directory,
    environment: { VIRTUAL_DESKTOP_REMOTE_PAINT_SOCKET: path, VIRTUAL_DESKTOP_REMOTE_PAINT_TOKEN: token,
      VIRTUAL_DESKTOP_REMOTE_FONT_DIRECTORY: fonts, VIRTUAL_DESKTOP_REMOTE_IMAGE_DIRECTORY: images },
    fontResource(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid native font ID');
      return { id, filePath: join(fonts, id + '.font') };
    },
    imageResource(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid native image ID');
      return { id, filePath: join(images, id + '.img') };
    },
    get stats() { return { ...stats, activeConnections: sockets.size }; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(done => server.close(done));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
