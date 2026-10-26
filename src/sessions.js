import { fork } from 'node:child_process';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, ensure } from './errors.js';

const token = () => randomBytes(32).toString('base64url');
export function sameToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

class WorkerClient {
  pending = new Map();
  sequence = 0;
  stopping = false;
  constructor(onExit) {
    this.child = fork(new URL('./worker.js', import.meta.url), [], {
      execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    });
    this.child.stderr.resume();
    this.child.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      error ? pending.reject(new AppError(error.status, error.code, error.message)) : pending.resolve(result);
    });
    this.child.on('error', () => this.fail());
    this.exited = new Promise(resolve => this.child.once('exit', () => {
      this.fail();
      if (!this.stopping) onExit();
      resolve();
    }));
  }
  fail() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError(503, 'WORKER_UNAVAILABLE', 'Execution process is unavailable; observe before retrying'));
    }
    this.pending.clear();
  }
  call(method, params) {
    ensure(this.child.connected && !this.stopping, 503, 'WORKER_UNAVAILABLE', 'Execution process is unavailable');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(504, 'WORKER_TIMEOUT', 'Operation result is unknown; observe before retrying'));
        this.child.kill('SIGKILL');
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, params }, error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id);
        reject(new AppError(503, 'WORKER_UNAVAILABLE', 'Execution process is unavailable'));
      });
    });
  }
  async stop() {
    this.stopping = true;
    this.child.kill('SIGTERM');
    await this.exited;
  }
}

export class SessionManager {
  sessions = new Map();
  profileLocks = new Map();
  queue = [];
  reserved = 0;
  starting = 0;
  closing = false;
  starts = new Set();

  constructor({ dataDir, maxActive = 8, maxQueued = 16, maxStarting = 2, queueTimeoutMs = 15000 } = {}) {
    this.dataDir = dataDir || '.data';
    for (const [name, value] of Object.entries({ maxActive, maxQueued, maxStarting, queueTimeoutMs })) {
      ensure(Number.isInteger(value) && value > 0, 500, 'INVALID_CONFIG', `${name} must be a positive integer`);
      this[name] = value;
    }
  }

  async create({ profileId = randomUUID(), viewport = { width: 960, height: 720 } } = {}) {
    ensure(!this.closing, 503, 'SHUTTING_DOWN', 'Service is stopping');
    ensure(this.sessions.size < 4096, 429, 'SESSION_RECORD_LIMIT', 'Local experiment session record limit reached');
    ensure(typeof profileId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(profileId), 400, 'INVALID_PROFILE', 'Invalid profile id');
    ensure(viewport && Number.isInteger(viewport.width) && viewport.width >= 480 && viewport.width <= 1600 && Number.isInteger(viewport.height) && viewport.height >= 320 && viewport.height <= 1600, 400, 'INVALID_VIEWPORT', 'Invalid viewport');
    ensure(!this.profileLocks.has(profileId), 409, 'PROFILE_BUSY', 'Profile already has a writer or queued request');
    ensure(this.queue.length < this.maxQueued, 429, 'QUEUE_FULL', 'Session creation queue is full');
    const s = { id: randomUUID(), profileId, state: 'QUEUED', viewport, epoch: 1, owner: 'agent',
      agentToken: token(), viewerToken: token(), humanToken: token(), chain: Promise.resolve(), createdAt: new Date().toISOString() };
    this.sessions.set(s.id, s);
    this.profileLocks.set(profileId, s.id);
    return new Promise((resolve, reject) => {
      Object.assign(s, { resolve, reject });
      s.queueTimer = setTimeout(() => {
        this.queue = this.queue.filter(item => item !== s);
        s.state = 'FAILED';
        this.profileLocks.delete(profileId);
        reject(new AppError(503, 'QUEUE_TIMEOUT', 'Session admission timed out'));
      }, this.queueTimeoutMs);
      this.queue.push(s);
      this.pump();
    });
  }

  pump() {
    while (!this.closing && this.queue.length && this.reserved < this.maxActive && this.starting < this.maxStarting) {
      const s = this.queue.shift();
      clearTimeout(s.queueTimer);
      s.state = 'CREATING'; s.reserved = true;
      this.reserved++; this.starting++;
      const operation = this.start(s);
      this.starts.add(operation);
      operation.finally(() => this.starts.delete(operation));
    }
  }

  async start(s) {
    try {
      let saved;
      try {
        const file = JSON.parse(await readFile(join(this.dataDir, `${s.profileId}.json`), 'utf8'));
        ensure(file.version === 1 && file.profileId === s.profileId, 409, 'INVALID_PROFILE_STATE', 'Unsupported saved profile');
        saved = file.state;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      ensure(!this.closing, 503, 'SHUTTING_DOWN', 'Service is stopping');
      s.worker = new WorkerClient(() => {
        s.state = 'FAILED';
        this.profileLocks.delete(s.profileId);
        this.releaseSlot(s);
      });
      await s.worker.call('init', { saved, viewport: s.viewport });
      s.state = 'ACTIVE';
      s.resolve({ ...this.public(s), agentToken: s.agentToken, viewerToken: s.viewerToken, humanToken: s.humanToken });
    } catch (error) {
      if (s.worker) await s.worker.stop();
      s.state = 'FAILED';
      this.profileLocks.delete(s.profileId);
      this.releaseSlot(s);
      s.reject(error);
    } finally { this.starting--; this.pump(); }
  }

  releaseSlot(s) {
    if (s.reserved) { s.reserved = false; this.reserved--; }
    this.pump();
  }
  public(s) { return { id: s.id, profileId: s.profileId, state: s.state, epoch: s.epoch, owner: s.owner, createdAt: s.createdAt }; }
  get(id) {
    const s = this.sessions.get(id);
    ensure(s, 404, 'SESSION_NOT_FOUND', 'Session not found');
    return s;
  }
  role(s, credential) {
    for (const role of ['agent', 'viewer', 'human']) if (sameToken(credential, s[`${role}Token`])) return role;
    throw new AppError(403, 'FORBIDDEN', 'Invalid session capability');
  }
  serial(s, fn) {
    ensure((s.pendingOperations || 0) < 64, 429, 'COMMAND_QUEUE_FULL', 'Session command queue is full');
    s.pendingOperations = (s.pendingOperations || 0) + 1;
    const operation = s.chain.then(fn).finally(() => { s.pendingOperations--; });
    s.chain = operation.catch(() => {});
    return operation;
  }
  active(s) { ensure(s.state === 'ACTIVE', 409, 'SESSION_NOT_ACTIVE', `Session is ${s.state}`); }

  async read(id, credential, method, params) {
    const s = this.get(id); this.role(s, credential);
    return this.serial(s, async () => {
      this.active(s);
      const result = await s.worker.call(method, params);
      return { ...result, sessionId: s.id, control: { owner: s.owner, epoch: s.epoch } };
    });
  }
  async action(id, credential, { epoch, actionId, action } = {}) {
    const s = this.get(id), role = this.role(s, credential);
    ensure(typeof actionId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(actionId), 400, 'INVALID_ACTION_ID', 'A unique actionId is required');
    ensure(action && typeof action === 'object' && !Array.isArray(action), 400, 'INVALID_ACTION', 'An action object is required');
    return this.serial(s, async () => {
      this.active(s);
      ensure(role !== 'viewer', 403, 'READ_ONLY', 'Viewer cannot change page state');
      ensure(epoch === s.epoch && role === s.owner, 409, 'CONTROL_LOST', 'Control lease changed; observe before continuing');
      return s.worker.call('action', { actionId, action });
    });
  }
  async control(id, credential, { epoch, owner } = {}) {
    const s = this.get(id);
    ensure(this.role(s, credential) === 'human', 403, 'FORBIDDEN', 'Human capability is required to transfer control');
    ensure(['agent', 'human'].includes(owner), 400, 'INVALID_OWNER', 'Owner must be agent or human');
    return this.serial(s, () => {
      this.active(s);
      ensure(epoch === s.epoch, 409, 'CONTROL_LOST', 'Control lease changed');
      s.owner = owner; s.epoch++;
      return { owner, epoch: s.epoch };
    });
  }
  async release(id, { save = true } = {}) {
    const s = this.get(id);
    return this.serial(s, async () => {
      this.active(s);
      s.state = 'EVICTING';
      try {
        if (save) {
          const state = await s.worker.call('save');
          await mkdir(this.dataDir, { recursive: true });
          const target = join(this.dataDir, `${s.profileId}.json`), temporary = `${target}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify({ version: 1, profileId: s.profileId, savedAt: new Date().toISOString(), state }), { mode: 0o600 });
          await rename(temporary, target);
        }
      } catch (error) { s.state = 'ACTIVE'; throw error; }
      await s.worker.stop();
      s.state = 'COLD';
      this.profileLocks.delete(s.profileId);
      this.releaseSlot(s);
      return this.public(s);
    });
  }
  stats() { return { active: this.reserved, starting: this.starting, queued: this.queue.length, total: this.sessions.size, maxActive: this.maxActive, maxQueued: this.maxQueued }; }
  async close() {
    this.closing = true;
    for (const s of this.queue.splice(0)) {
      clearTimeout(s.queueTimer); s.state = 'FAILED';
      this.profileLocks.delete(s.profileId);
      s.reject(new AppError(503, 'SHUTTING_DOWN', 'Service is stopping'));
    }
    await Promise.allSettled([...this.starts]);
    await Promise.allSettled([...this.sessions.values()].map(async s => {
      await s.chain;
      if (s.worker) await s.worker.stop();
    }));
  }
}
