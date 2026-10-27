import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/app.js';
import { LayoutEngine } from '../src/layout.js';
import { applyFrame, diffScene } from '../src/protocol.js';

test('display-list delta reconstructs exact scene, including new and removed nodes', () => {
  const app = createApplication();
  const layout = new LayoutEngine(app.document);
  const before = layout.scene({ width: 960, height: 720 }, 1);
  app.document.querySelector('#task-input').value = 'Protocol test';
  app.document.querySelector('#add-task').dispatchEvent(new app.window.Event('click'));
  app.document.querySelector('#chart').remove();
  const after = layout.scene({ width: 960, height: 720 }, 2);
  const delta = diffScene(before, after);
  assert.deepEqual(applyFrame(before, delta), after);
  assert.ok(delta.upserts.length > 0);
  assert.ok(delta.removes.length > 0);
  assert.ok(after.commands.some(command => command.text === 'Protocol test'));
  assert.throws(() => applyFrame({ ...before, seq: 0 }, delta), /BASE_MISMATCH/);
});

test('layout emits bounded coordinates, input targets and no pixel payloads', () => {
  const app = createApplication();
  const scene = new LayoutEngine(app.document).scene({ width: 960, height: 720 }, 1);
  assert.equal(scene.targets.length, 4);
  assert.ok(scene.commands.some(command => command.text === 'Agent workspace' && command.width > 0));
  for (const command of scene.commands) {
    assert.ok(['rect', 'text', 'path'].includes(command.op));
    assert.doesNotMatch(JSON.stringify(command), /data:image|base64|screenshot|bitmap/i);
    if ('x' in command) assert.ok(Number.isFinite(command.x));
  }
  assert.ok(scene.targets.find(target => target.selector === '#add-task').x > scene.targets[0].x);
});
