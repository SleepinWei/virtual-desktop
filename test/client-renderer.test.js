import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { createApplication } from '../src/app.js';
import { LayoutEngine } from '../src/layout.js';
import { diffScene, applyFrame } from '../src/protocol.js';
import { drawScene } from '../public/renderer.js';

test('client drawing code rasterizes vector commands into real pixels', async t => {
  const oldWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  t.after(() => { globalThis.window = oldWindow; });
  const app = createApplication();
  const layout = new LayoutEngine(app.document);
  const scene = layout.scene({ width: 960, height: 720 }, 1);
  const canvas = createCanvas(960, 720);
  canvas.dataset = {};
  drawScene(canvas, scene);
  assert.deepEqual([...canvas.getContext('2d').getImageData(802, 185, 1, 1).data], [36, 99, 235, 255]);
  assert.deepEqual([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data], [240, 244, 250, 255]);
  assert.equal(canvas.dataset.seq, '1');
  const before = canvas.toBuffer('image/png');
  app.document.querySelector('#increment').dispatchEvent(new app.window.Event('click'));
  const next = layout.scene({ width: 960, height: 720 }, 2);
  drawScene(canvas, applyFrame(scene, diffScene(scene, next)));
  assert.notDeepEqual(canvas.toBuffer('image/png'), before, 'Updated counter must change actual client pixels');
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/client-frame.png', canvas.toBuffer('image/png'));
});

test('client respects device pixel ratio while preserving CSS-space geometry', t => {
  const oldWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 2 };
  t.after(() => { globalThis.window = oldWindow; });
  const app = createApplication();
  const scene = new LayoutEngine(app.document).scene({ width: 960, height: 720 }, 1);
  const canvas = createCanvas(960, 720);
  canvas.dataset = {};
  drawScene(canvas, scene);
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1440);
  assert.deepEqual([...canvas.getContext('2d').getImageData(1604, 370, 1, 1).data], [36, 99, 235, 255]);
});
