import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createService } from '../src/server.js';

export async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(process.cwd(), '.test-data-'));
  const service = createService({ dataDir, adminToken: 'test-admin', ...options });
  const baseUrl = await service.listen(0);
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, credential = 'test-admin', method = 'GET', payload) {
    const response = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${credential}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    const data = await response.json();
    return { status: response.status, data };
  }
  async function create(payload = {}) {
    const result = await request('/api/sessions', 'test-admin', 'POST', payload);
    if (result.status !== 201) throw new Error(JSON.stringify(result));
    return result.data;
  }
  return { service, baseUrl, dataDir, request, create };
}

export function actionPayload(epoch, action, actionId = crypto.randomUUID()) { return { epoch, action, actionId }; }
