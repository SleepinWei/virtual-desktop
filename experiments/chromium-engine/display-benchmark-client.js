const canvas = document.querySelector('canvas'), config = await (await fetch('/benchmark-config')).json();
const paint = { calls: 0, rasterMs: 0, decodeMs: 0 }, samples = [];
let client, latest, failure;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const jsonPost = (path, value) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const tick = () => new Promise(requestAnimationFrame);
async function jpegOrPng(response) {
  const data = await response.blob(), beforeDecode = performance.now(), bitmap = await createImageBitmap(data);
  paint.decodeMs += performance.now() - beforeDecode;
  const beforeDraw = performance.now();
  try { canvas.getContext('2d').drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
  paint.rasterMs += performance.now() - beforeDraw; paint.calls++;
}
async function waitForRevision(revision) {
  const deadline = performance.now() + 10000;
  while (!latest || latest.revision < revision) {
    if (failure) throw new Error(failure);
    check(performance.now() < deadline, 'No native presentation for the action revision'); await tick();
  }
}
if (config.mode === 'native-records') {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/native-runtime/canvaskit.js'; script.onload = resolve; script.onerror = reject;
    document.head.append(script);
  });
  const kit = await window.CanvasKitInit({ locateFile: file => '/native-runtime/' + file });
  const { NativeClient } = await import('/native-client.js');
  client = new NativeClient({ kit, canvas, session: config.session, onControl() {},
    onStatus(status, message) { if (['error', 'ended'].includes(status)) failure = message; },
    onFrame(frame) { latest = { revision: frame.revision, frameId: frame.frameId }; } });
  const present = client.painter.present.bind(client.painter);
  client.painter.present = (...args) => {
    const before = performance.now();
    try { return present(...args); } finally { paint.rasterMs += performance.now() - before; paint.calls++; }
  };
  await client.connect(); await waitForRevision(1);
} else {
  const response = await fetch('/benchmark-image'); check(response.ok, 'Missing initial screenshot'); await jpegOrPng(response);
}
await tick(); await tick();
check((await jsonPost('/benchmark-presented', { initial: true })).ok, 'Initial display acknowledgement failed');
document.documentElement.dataset.ready = 'true';
window.displayBenchmark = {
  state: () => ({ paint: { ...paint }, latest, failure, samples: [...samples] }),
  async action(index) {
    const began = performance.now(), beforePaint = { ...paint };
    const response = await jsonPost('/benchmark-action', { index });
    check(response.ok, 'Action failed: ' + await (response.ok ? Promise.resolve('') : response.text()));
    const producerMs = Number(response.headers.get('X-Producer-Ms'));
    if (config.mode === 'native-records') {
      const result = await response.json(); check(result.changed, 'Action produced no new native drawing revision');
      await waitForRevision(result.revision);
    } else await jpegOrPng(response);
    // Both paths wait for two viewer animation frames, then the same local
    // acknowledgement. This measures canvas delivery, not physical scanout.
    await tick(); await tick();
    check((await jsonPost('/benchmark-presented', { index })).ok, 'Display acknowledgement failed');
    const result = { index, actionToPresentAckMs: performance.now() - began, producerMs,
      rasterMs: paint.rasterMs - beforePaint.rasterMs, imageDecodeMs: paint.decodeMs - beforePaint.decodeMs,
      paintedFrames: paint.calls - beforePaint.calls };
    samples.push(result); return result;
  },
  png: () => canvas.toDataURL('image/png').split(',')[1],
  stop: () => client?.stop(),
};
