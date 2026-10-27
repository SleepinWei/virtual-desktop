import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromium } from 'playwright';
import { fixture } from '../helpers.js';

async function viewer(t) {
  const f = await fixture(t);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1480, height: 1120 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.baseUrl);
  await page.locator('#admin-token').fill('test-admin');
  return { f, page, errors };
}

// Wait for parsed responses and painting instead of racing an async event collector.
// A fast batch can legitimately skip intermediate sequences and receive a snapshot.
async function paintAfter(page, action, { sessionId, excludeId, seq, unchanged = false }) {
  const frames = [], parsing = [];
  let painted;
  const response = page.waitForResponse(result => {
    if (!/\/api\/sessions\/[^/]+\/frame$/.test(new URL(result.url()).pathname)) return false;
    const parsed = result.json().then(frame => {
      if ((sessionId && frame.sessionId !== sessionId) || frame.sessionId === excludeId) return false;
      frames.push(frame);
      if (frame.seq !== seq || (!unchanged && frame.type === 'unchanged')) return false;
      painted = frame;
      return true;
    });
    parsing.push(parsed);
    return parsed;
  });
  await Promise.all([response, action()]);
  await Promise.all(parsing);
  await page.waitForFunction(({ id, expected }) => {
    const canvas = document.querySelector('#desktop');
    return document.querySelector('.session.selected')?.dataset.sessionId === id
      && canvas.dataset.ready === 'true' && Number(canvas.dataset.seq) === expected
      && document.querySelector('#connection').textContent === `Connected · ${id.slice(0, 8)}`;
  }, { id: painted.sessionId, expected: seq });
  return { frame: painted, frames };
}

function commands(frames) {
  return frames.flatMap(frame => frame.commands || frame.upserts || []);
}

const pixelSamples = new Map();
async function canvasImage(page) {
  // Browser getImageData can switch Chrome's renderer after repeated reads.
  // Export once and inspect decoded pixels in Node, leaving the tested context alone.
  const png = await page.locator('#desktop').evaluate(canvas => canvas.toDataURL('image/png'));
  const image = await loadImage(Buffer.from(png.split(',')[1], 'base64'));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { context, width: image.width, height: image.height };
}

async function pixels(page, region) {
  const image = await canvasImage(page);
  const { x = 0, y = 0, width = image.width, height = image.height } = region || {};
  const data = image.context.getImageData(x, y, width, height).data;
  let hash = 2166136261;
  for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
  const sample = { width, height, hash: hash >>> 0 };
  pixelSamples.set(JSON.stringify(sample), data);
  return sample;
}

async function samePixels(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  assert.equal(actual.width, expected.width, message);
  assert.equal(actual.height, expected.height, message);
  const before = pixelSamples.get(JSON.stringify(expected)), after = pixelSamples.get(JSON.stringify(actual));
  const diff = new Uint8ClampedArray(before.length), examples = [];
  let changedPixels = 0, maxChannelDelta = 0, minX = actual.width, minY = actual.height, maxX = -1, maxY = -1;
  for (let offset = 0; offset < before.length; offset += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(before[offset + channel] - after[offset + channel])));
    diff[offset + 3] = 255;
    if (!delta) continue;
    changedPixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
    const x = (offset / 4) % actual.width, y = Math.floor(offset / 4 / actual.width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    diff[offset] = 255;
    if (examples.length < 8) examples.push({ x, y, before: [...before.slice(offset, offset + 4)], after: [...after.slice(offset, offset + 4)] });
  }
  await mkdir('test-results', { recursive: true });
  await Promise.all([['before', before], ['after', after], ['diff', diff]].map(([name, data]) => {
    const image = createCanvas(actual.width, actual.height), context = image.getContext('2d');
    const imageData = context.createImageData(actual.width, actual.height);
    imageData.data.set(data);
    context.putImageData(imageData, 0, 0);
    return writeFile(`test-results/canvas-comparison-${name}.png`, image.toBuffer('image/png'));
  }));
  const details = { changedPixels, maxChannelDelta, bounds: { minX, minY, maxX, maxY }, examples };
  assert.deepEqual(actual, expected, `${message}\n${JSON.stringify(details)}\nSee test-results/canvas-comparison-{before,after,diff}.png`);
}

async function persistentPixels(page, frame) {
  // Task rows and counter persist; the transient status message resets to Ready.
  const targets = frame.targets.filter(target => /^#task-\d+$/.test(target.selector) || target.selector === '#increment');
  assert.ok(targets.length >= 2);
  return Promise.all(targets.map(target => pixels(page, {
    x: 0, y: Math.floor(target.y), width: frame.viewport.width, height: Math.ceil(target.height),
  })));
}

async function clickRemote(page, frame, selector) {
  const target = frame.targets.find(item => item.selector === selector);
  assert.ok(target, `Missing interactive target ${selector}`);
  const box = await page.locator('#desktop').boundingBox();
  await page.locator('#desktop').click({ position: {
    x: (target.x + target.width / 2) * box.width / frame.viewport.width,
    y: (target.y + target.height / 2) * box.height / frame.viewport.contentHeight,
  } });
}

async function postAfter(page, action, path) {
  const [response] = await Promise.all([
    page.waitForResponse(result => new URL(result.url()).pathname === path && result.request().method() === 'POST'),
    action(),
  ]);
  assert.equal(response.status(), 200);
  return response.json();
}

async function holdNextResponse(page, url) {
  const captured = Promise.withResolvers(), released = Promise.withResolvers(), done = Promise.withResolvers();
  await page.route(url, async route => {
    try {
      const response = await route.fetch({ timeout: 10000 });
      captured.resolve({ status: response.status(), body: await response.json() });
      await released.promise;
      await route.fulfill({ response });
      done.resolve();
    } catch (error) {
      captured.resolve({ error });
      done.resolve(error);
    }
  }, { times: 1 });
  return { captured: captured.promise, release: released.resolve, done: done.promise };
}

test('local client paints command frames, accepts takeover, switches sessions and restores a saved profile', { timeout: 45000 }, async t => {
  const { page, errors } = await viewer(t);
  const initial = await paintAfter(page, () => page.locator('#create-session').click(), { seq: 1 });
  const firstId = initial.frame.sessionId;
  assert.equal(initial.frame.type, 'snapshot');
  const pixel = [...(await canvasImage(page)).context.getImageData(802, 185, 1, 1).data];
  assert.deepEqual(pixel, [36, 99, 235, 255], 'The client Canvas must actually rasterize the blue button');
  const initialPixels = await pixels(page);

  const agent = await paintAfter(page, () => page.locator('#run-agent').click(), { sessionId: firstId, seq: 4 });
  assert.ok(['snapshot', 'delta'].includes(agent.frame.type));
  assert.ok(commands(agent.frames).some(command => command.text === 'Submitted by the example agent'));
  assert.ok(commands(agent.frames).some(command => command.text === '1'));
  const agentPixels = await pixels(page);
  assert.notDeepEqual(agentPixels, initialPixels, 'Agent actions must change actual browser Canvas pixels');
  const acquire = await postAfter(page, () => page.locator('#take-control').click(), `/api/sessions/${firstId}/control`);
  assert.deepEqual(acquire, { owner: 'human', epoch: 2 });
  await page.waitForFunction(() => document.querySelector('#mode').textContent === 'Human control');
  assert.equal(await page.locator('#run-agent').isDisabled(), true);

  const focused = await paintAfter(page, () => clickRemote(page, agent.frame, '#task-input'), { sessionId: firstId, seq: 5 });
  await page.waitForFunction(() => !document.querySelector('#remote-input').disabled);
  await page.locator('#remote-input').fill('Added through local rendering');
  const filled = await paintAfter(page, () => page.locator('#send-input').click(), { sessionId: firstId, seq: 6 });
  // The preceding paint was awaited and this is one action, so a delta is required.
  assert.equal(focused.frame.type, 'delta');
  assert.equal(filled.frame.type, 'delta');
  assert.ok(filled.frame.upserts.some(command => command.text === 'Added through local rendering'));
  const filledPixels = await pixels(page);
  assert.notDeepEqual(filledPixels, agentPixels, 'Human input must be drawn into the Canvas');
  const added = await paintAfter(page, () => clickRemote(page, filled.frame, '#add-task'), { sessionId: firstId, seq: 7 });
  assert.ok(commands(added.frames).some(command => command.text === 'Added through local rendering'));
  const humanPixels = await pixels(page);
  assert.notDeepEqual(humanPixels, filledPixels, 'Submitting the task must repaint the Canvas');
  const savedPixels = await persistentPixels(page, added.frame);

  const second = await paintAfter(page, () => page.locator('#create-session').click(), { excludeId: firstId, seq: 1 });
  assert.notEqual(second.frame.sessionId, firstId);
  await samePixels(await pixels(page), initialPixels, 'Switching to a new session must paint its clean state');
  await paintAfter(page, () => page.locator(`[data-session-id="${firstId}"]`).click(), { sessionId: firstId, seq: 7, unchanged: true });
  assert.equal(await page.locator('#mode').textContent(), 'Human control');
  assert.deepEqual(await pixels(page), humanPixels, 'Switching back must restore the first session pixels');
  const returned = await postAfter(page, () => page.locator('#release-control').click(), `/api/sessions/${firstId}/control`);
  assert.deepEqual(returned, { owner: 'agent', epoch: 3 });
  await page.waitForFunction(() => !document.querySelector('#run-agent').disabled);

  const saved = await postAfter(page, () => page.locator('#save-close').click(), `/api/sessions/${firstId}/release`);
  assert.equal(saved.state, 'COLD');
  await page.waitForFunction(() => !document.querySelector('#resume').disabled);
  const restored = await paintAfter(page, () => page.locator('#resume').click(), { excludeId: firstId, seq: 1 });
  assert.notEqual(restored.frame.sessionId, firstId);
  assert.notEqual(restored.frame.sessionId, second.frame.sessionId);
  assert.equal(restored.frame.type, 'snapshot');
  assert.ok(restored.frame.commands.some(command => command.text === 'Added through local rendering'));
  assert.ok(restored.frame.commands.some(command => command.text === '1'));
  assert.deepEqual(await persistentPixels(page, restored.frame), savedPixels, 'Restored task and counter pixels must match the saved session');
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/viewer.png', fullPage: true });
});

test('a delayed save response cannot disconnect the session selected in the meantime', { timeout: 45000 }, async t => {
  const { f, page, errors } = await viewer(t);
  const first = await paintAfter(page, () => page.locator('#create-session').click(), { seq: 1 });
  const firstId = first.frame.sessionId;
  const second = await paintAfter(page, () => page.locator('#create-session').click(), { excludeId: firstId, seq: 1 });
  const secondId = second.frame.sessionId;
  await paintAfter(page, () => page.locator(`[data-session-id="${firstId}"]`).click(), { sessionId: firstId, seq: 1, unchanged: true });
  const save = await holdNextResponse(page, `${f.baseUrl}/api/sessions/${firstId}/release`);
  try {
    await page.locator('#save-close').click();
    const result = await save.captured;
    assert.ifError(result.error);
    assert.equal(result.status, 200);
    assert.equal(result.body.state, 'COLD', 'The save must reach the server before switching sessions');
    await paintAfter(page, () => page.locator(`[data-session-id="${secondId}"]`).click(), { sessionId: secondId, seq: 1, unchanged: true });
    const before = await pixels(page);
    save.release();
    assert.ifError(await save.done);
    await page.waitForFunction(id => document.querySelector(`[data-session-id="${id}"] small`).textContent.includes('COLD'), firstId);
    assert.equal(await page.locator('.session.selected').getAttribute('data-session-id'), secondId);
    assert.equal(await page.locator('#connection').textContent(), `Connected · ${secondId.slice(0, 8)}`);
    assert.equal(await page.locator('#run-agent').isDisabled(), false);
    await paintAfter(page, () => page.locator('#run-agent').click(), { sessionId: secondId, seq: 4 });
    assert.notDeepEqual(await pixels(page), before, 'The selected session must keep polling and painting after the other save completes');
    assert.deepEqual(errors, []);
  } finally {
    save.release();
  }
});

test('a delayed frame cannot overwrite a newer human control epoch', { timeout: 45000 }, async t => {
  const { f, page, errors } = await viewer(t);
  const initial = await paintAfter(page, () => page.locator('#create-session').click(), { seq: 1 });
  const initialPixels = await pixels(page);
  const id = initial.frame.sessionId;
  const frameUrl = `${f.baseUrl}/api/sessions/${id}/frame**`;
  const old = await holdNextResponse(page, frameUrl);
  let fresh;
  try {
    const previous = await old.captured;
    assert.ifError(previous.error);
    assert.deepEqual(previous.body.control, { owner: 'agent', epoch: 1 });
    const acquire = await postAfter(page, () => page.locator('#take-control').click(), `/api/sessions/${id}/control`);
    assert.deepEqual(acquire, { owner: 'human', epoch: 2 });
    await page.waitForFunction(() => document.querySelector('#mode').textContent === 'Human control');
    // Hold the following response too: it must not hide a transient epoch regression.
    fresh = await holdNextResponse(page, frameUrl);
    old.release();
    assert.ifError(await old.done);
    const next = await fresh.captured;
    assert.ifError(next.error);
    assert.deepEqual(next.body.control, { owner: 'human', epoch: 2 });
    assert.equal(await page.locator('#mode').textContent(), 'Human control');
    assert.equal(await page.locator('#run-agent').isDisabled(), true);
    assert.equal(await page.locator('#release-control').isDisabled(), false);
    fresh.release();
    assert.ifError(await fresh.done);
    await paintAfter(page, () => clickRemote(page, initial.frame, '#increment'), { sessionId: id, seq: 2 });
    assert.notDeepEqual(await pixels(page), initialPixels, 'The retained human epoch must still allow a visible interaction');
    assert.deepEqual(errors, []);
  } finally {
    old.release();
    fresh?.release();
  }
});
