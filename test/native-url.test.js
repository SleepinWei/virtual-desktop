import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSiteUrl, allowedSiteRequest } from '../experiments/chromium-engine/sites.js';
import { SessionManager } from '../src/sessions.js';
import { fixture } from './helpers.js';

test('pasted URLs resolve their own site and retain path, query and fragment with HTTPS defaults', () => {
  for (const [input, url] of [
    ['  www.bilibili.com  ', 'https://www.bilibili.com/'],
    ['//search.bilibili.com/all?keyword=virtual desktop', 'https://search.bilibili.com/all?keyword=virtual%20desktop'],
    ['https://www.bilibili.com/read/cv1?from=preview#comments', 'https://www.bilibili.com/read/cv1?from=preview#comments'],
    ['https://www.bilibili.com:443/', 'https://www.bilibili.com/'],
  ]) {
    const target = resolveSiteUrl(input);
    assert.deepEqual(target, { site: 'bilibili', url });
    assert.equal(allowedSiteRequest(target.site, target.url, { navigation: true }), true);
  }
  assert.equal(resolveSiteUrl('https://info.cern.ch/hypertext/WWW/TheProject.html').site, 'cern');
});

test('URL entry cannot turn resource domains, private targets or malformed addresses into navigation', () => {
  for (const address of [undefined, null, {}, 42, '', 'x'.repeat(4097), 'http://www.bilibili.com/',
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://127.0.0.1/', 'https://[::1]/',
    'https://localhost/', 'https://example.invalid/', 'https://bilibili.com.evil.test/',
    'https://user:password@www.bilibili.com/', 'https://www.bilibili.com:8443/', 'https://i0.hdslb.com/a.jpg',
    'https://www.bilibili.com\\@evil.test/', 'https://www.bili\nbili.com/']) assert.equal(resolveSiteUrl(address), null);
});

test('URL preflight checks management authority and configuration without creating any session', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/native/targets/resolve', 'viewer', 'POST', { url: 'www.bilibili.com' })).data.error.code, 'FORBIDDEN');
  assert.equal((await f.request('/api/native/targets/resolve', 'test-admin', 'POST', { url: 'www.bilibili.com' })).data.error.code, 'NATIVE_NOT_CONFIGURED');
  f.service.manager.nativeConfig = { externalSites: false };
  assert.equal((await f.request('/api/native/targets/resolve', 'test-admin', 'POST', { url: 'www.bilibili.com' })).data.error.code, 'NATIVE_URL_DISABLED');
  f.service.manager.nativeConfig.externalSites = true;
  const resolved = await f.request('/api/native/targets/resolve', 'test-admin', 'POST', { url: 'search.bilibili.com/all?keyword=test' });
  assert.equal(resolved.status, 200); assert.equal(resolved.data.site, 'bilibili');
  assert.equal(resolved.data.url, 'https://search.bilibili.com/all?keyword=test');
  assert.equal((await f.request('/api/native/targets/resolve', 'test-admin', 'POST', { url: 'https://127.0.0.1/' })).status, 400);
  assert.deepEqual(f.service.manager.stats(), { active: 0, starting: 0, queued: 0, total: 0, maxActive: 8, maxQueued: 16 });
});

test('invalid URL creation is rejected before admission even when native capacity is occupied', async t => {
  const manager = new SessionManager(); t.after(() => manager.close());
  manager.nativeConfig = { externalSites: true, maxSessions: 1 };
  manager.sessions.set('existing', { backend: 'chromium', state: 'ACTIVE' });
  await assert.rejects(manager.create({ backend: 'chromium', url: 'https://127.0.0.1/' }), error => error.code === 'URL_NOT_ALLOWED');
  await assert.rejects(manager.create({ backend: 'chromium', url: 'www.bilibili.com' }), error => error.code === 'NATIVE_SESSION_LIMIT');
  await assert.rejects(manager.create({ url: 'www.bilibili.com' }), error => error.code === 'INVALID_URL');
  assert.equal(manager.sessions.size, 1); assert.equal(manager.profileLocks.size, 0); assert.equal(manager.queue.length, 0);
});
