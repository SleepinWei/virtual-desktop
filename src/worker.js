import { createApplication } from './app.js';
import { LayoutEngine } from './layout.js';
import { diffScene } from './protocol.js';
import { ensure } from './errors.js';
import { getHeapStatistics } from 'node:v8';

let app, layout, scene, previous, viewport, seq = 0;
const actions = new Map();
function update() {
  previous = scene;
  scene = layout.scene(viewport, ++seq);
  return scene;
}
function dispatch(method, params = {}) {
  if (method === 'init') {
    app = createApplication(params.saved);
    layout = new LayoutEngine(app.document);
    viewport = params.viewport;
    return update();
  }
  if (method === 'frame') return params.since === scene.seq ? { type: 'unchanged', seq } : params.since === previous?.seq ? diffScene(previous, scene) : { type: 'snapshot', ...scene };
  if (method === 'observe') return { seq, title: 'Agent workspace', text: app.document.querySelector('#app').textContent.replace(/\s+/g, ' ').trim(), targets: scene.targets };
  if (method === 'save') return app.save();
  if (method === 'metrics') {
    let memory;
    try { memory = process.memoryUsage(); }
    catch {
      const heap = getHeapStatistics();
      memory = { rss: null, heapUsed: heap.used_heap_size, heapTotal: heap.total_heap_size, rssUnavailable: true };
    }
    return { pid: process.pid, memory, maxRssKiB: process.resourceUsage().maxRSS,
      commandCount: scene.commands.length, seq, pixelBackend: null, runtime: 'linkedom-yoga-poc' };
  }
  if (method === 'action') {
    const { actionId, action } = params;
    const signature = JSON.stringify(action);
    if (actions.has(actionId)) {
      const old = actions.get(actionId);
      ensure(old.signature === signature, 409, 'ACTION_ID_REUSED', 'Action id already used with a different payload');
      return { ...old.result, deduplicated: true };
    }
    if (action.type === 'viewport') {
      ensure(Number.isInteger(action.width) && action.width >= 480 && action.width <= 1600 && Number.isInteger(action.height) && action.height >= 320 && action.height <= 1600, 400, 'INVALID_VIEWPORT', 'Viewport must be between 480x320 and 1600x1600');
      viewport = { width: action.width, height: action.height };
    } else {
      let selector = action.selector;
      if (action.type === 'pointer') {
        ensure(action.seq === seq, 409, 'STALE_FRAME', 'Observe the current frame before clicking');
        ensure(Number.isFinite(action.x) && Number.isFinite(action.y), 400, 'INVALID_COORDINATES', 'Coordinates must be finite');
        const target = [...scene.targets].reverse().find(target => action.x >= target.x && action.x <= target.x + target.width && action.y >= target.y && action.y <= target.y + target.height);
        ensure(target, 422, 'NO_TARGET', 'No interactive target at these coordinates');
        selector = target.selector;
      }
      ensure(typeof selector === 'string' && selector.length <= 200, 400, 'INVALID_SELECTOR', 'A short CSS selector is required');
      let element;
      try { element = app.document.querySelector(selector); } catch { ensure(false, 400, 'INVALID_SELECTOR', 'Invalid CSS selector'); }
      ensure(element, 404, 'ELEMENT_NOT_FOUND', 'Selector matched no element');
      if (action.type === 'fill') {
        ensure(element.localName === 'input', 422, 'NOT_EDITABLE', 'Only input is editable in v0');
        ensure(typeof action.value === 'string' && action.value.length <= 200, 400, 'INVALID_VALUE', 'Input is limited to 200 characters');
        element.value = action.value;
        element.dispatchEvent(new app.window.Event('input', { bubbles: true }));
      } else if (action.type === 'click' || action.type === 'pointer') {
        ensure(['button', 'input'].includes(element.localName), 422, 'NOT_INTERACTIVE', 'Target is not interactive');
        if (element.localName === 'button') element.dispatchEvent(new app.window.Event('click', { bubbles: true }));
      } else ensure(false, 400, 'UNSUPPORTED_ACTION', 'Unsupported action');
    }
    update();
    const result = { seq, actionId, deduplicated: false };
    actions.set(actionId, { signature, result });
    if (actions.size > 1000) actions.delete(actions.keys().next().value);
    return result;
  }
  ensure(false, 400, 'UNSUPPORTED_METHOD', 'Unsupported worker method');
}

process.on('message', ({ id, method, params }) => {
  try { process.send?.({ id, result: dispatch(method, params) }); }
  catch (error) { process.send?.({ id, error: { status: error.status || 500, code: error.code || 'WORKER_ERROR', message: error.status ? error.message : 'Worker execution failed' } }); }
});
process.on('disconnect', () => process.exit(0));
