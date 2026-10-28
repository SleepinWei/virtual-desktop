import { ChromiumSession } from './session.js';

// At most one IPC send plus one coalesced latest complete resource set.
let latest, sending = false, produced = 0, delivered = 0, stopping = false;
const waits = [];
function flush() {
  const target = produced;
  return delivered >= target ? Promise.resolve() : new Promise((resolve, reject) => waits.push({ target, resolve, reject }));
}
function sendLatest() {
  if (sending || !latest || !process.connected) return;
  const current = latest; latest = null; sending = true;
  process.send({ event: 'native-frame', payload: current.payload }, error => {
    sending = false;
    if (error) { for (const wait of waits.splice(0)) wait.reject(error); return; }
    delivered = current.sequence;
    for (let index = waits.length - 1; index >= 0; index--) if (waits[index].target <= delivered) waits.splice(index, 1)[0].resolve();
    sendLatest();
  });
}
const backend = new ChromiumSession({
  onFrame(payload) { latest = { payload, sequence: ++produced }; sendLatest(); },
  onFault(message, fatal = false) { process.send?.({ event: 'native-fault', message, fatal }); },
  onBrowser(pid) { process.send?.({ event: 'native-browser', pid }); },
});
let chain = Promise.resolve();
process.on('message', ({ id, method, params }) => {
  chain = chain.then(async () => {
    try {
      const result = method === 'init' ? await backend.start(params) : await backend.dispatch(method, params);
      await flush();
      process.send?.({ id, result });
    } catch (error) {
      process.send?.({ id, error: { status: error.status || 502, code: error.code || 'NATIVE_WORKER_ERROR',
        message: error.status ? error.message : 'Native execution failed; inspect the local build and supported fixture' } });
    }
  });
});
async function close() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 3000); timer.unref();
  await backend.close().catch(() => {}); process.exit(0);
}
process.on('disconnect', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
