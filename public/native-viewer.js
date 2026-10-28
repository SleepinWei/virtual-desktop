import { NativeClient } from '/native-client.js';

const $ = selector => document.querySelector(selector), canvas = $('#desktop');
let session, client, kit, control = { owner: 'agent', epoch: 1 }, busy = false, inputBusy = false, lastFrame;
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function buttons() {
  const active = session?.state === 'ACTIVE', human = active && control.owner === 'human';
  $('#create').disabled = busy || active;
  $('#take').disabled = busy || !active || human; $('#return').disabled = busy || !active || !human;
  $('#close').disabled = busy || !active; $('#reconnect').disabled = busy || !active;
  for (const element of [$('#text'), $('#send'), ...document.querySelectorAll('[data-key]')]) element.disabled = !human || busy;
  $('#owner').textContent = `${human ? 'You own' : 'Agent owns'} input · control ${control.epoch}`;
}
function mergeControl(value) { if (value?.epoch >= control.epoch) { control = value; buttons(); } }
async function attachSession(value) {
  kit ||= await window.CanvasKitInit({ locateFile: file => '/native-runtime/' + file });
  session = value; control = { owner: value.owner, epoch: value.epoch };
  sessionStorage.setItem('vd-native-viewer', JSON.stringify(session));
  $('#session').textContent = `Chromium session ${session.id.slice(0, 8)}`;
  client = new NativeClient({ kit, canvas, session,
    onControl: mergeControl,
    onStatus(status, message) {
      $('#connection').textContent = message; $('#connection').classList.toggle('error', status === 'error');
      document.documentElement.dataset.connection = status;
      if (status === 'ended') { session.state = 'FAILED'; sessionStorage.removeItem('vd-native-viewer'); buttons(); }
      if (status === 'connected') notice('Live frame ready. Reconnecting the viewer keeps this Chromium page alive.');
    },
    onFrame(frame) {
      lastFrame = frame; canvas.dataset.ready = 'true'; canvas.dataset.revision = String(frame.revision);
      $('#frame').textContent = `Frame ${frame.revision} · ${frame.frame.surfaces.length} surfaces · ${frame.downloads.resources} resources received`;
    },
  });
  await client.connect();
}
async function request(operation, payload, credential = session?.humanToken) {
  const response = await fetch(`/api/sessions/${session.id}/${operation}`, { method: 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (result.control) mergeControl(result.control);
  return result;
}
async function input(action) {
  if (inputBusy || control.owner !== 'human') return;
  if (!client?.presented) { notice('Wait for a complete frame before sending input.', true); return; }
  inputBusy = true;
  try {
    await request('actions', { epoch: control.epoch, actionId: crypto.randomUUID(), action: { ...action, ...client.presented } });
    notice('Input sent to the running Chromium page.');
  } catch (error) { notice(error.code === 'STALE_FRAME' ? 'The page changed. Wait for the next frame, then try again.' : error.message, true); }
  finally { inputBusy = false; }
}
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || session?.state === 'ACTIVE') return;
  busy = true; buttons(); $('#create').textContent = 'Starting Chromium…'; notice('Starting a verified native browser session…');
  try {
    const health = await (await fetch('/health')).json();
    if (!health.nativeAvailable) throw new Error('Native backend is not configured. Start the verified native service first.');
    kit ||= await window.CanvasKitInit({ locateFile: file => '/native-runtime/' + file });
    const response = await fetch('/api/sessions', { method: 'POST', headers: {
      Authorization: `Bearer ${$('#admin-token').value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: 'chromium', fixture: $('#fixture').value, viewport: { width: 960, height: 720 } }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error.message);
    delete canvas.dataset.ready;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    await attachSession(result);
  } catch (error) { notice(error.message, true); }
  finally { busy = false; $('#create').textContent = 'Create session'; buttons(); }
});
for (const [selector, owner] of [['#take', 'human'], ['#return', 'agent']]) $(selector).addEventListener('click', async () => {
  if (busy) return; busy = true; buttons();
  try { mergeControl(await request('control', { epoch: control.epoch, owner })); notice(owner === 'human' ? 'You can click and scroll in the page. Use the text field below for native input.' : 'Input returned to the agent.'); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; buttons(); }
});
$('#reconnect').addEventListener('click', async () => {
  if (!client || busy) return; busy = true; buttons();
  try { if (client.stopped) await attachSession(session); else await client.connect(); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; buttons(); }
});
$('#close').addEventListener('click', async () => {
  if (!session || busy) return; busy = true; buttons();
  try { await client.stop(); await request('release', { save: false }, $('#admin-token').value); session.state = 'COLD';
    sessionStorage.removeItem('vd-native-viewer');
    $('#connection').textContent = 'Session closed'; document.documentElement.dataset.connection = 'closed'; notice('The owned Chromium browser was stopped.'); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; buttons(); }
});
canvas.addEventListener('click', event => {
  const bounds = canvas.getBoundingClientRect(); canvas.focus({ preventScroll: true });
  input({ type: 'pointer', x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height });
});
canvas.addEventListener('wheel', event => {
  if (control.owner !== 'human') return;
  event.preventDefault();
  const bounds = canvas.getBoundingClientRect(), multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.height : 1;
  input({ type: 'wheel', x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height,
    deltaX: Math.max(-2000, Math.min(2000, event.deltaX * multiplier)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY * multiplier)) });
}, { passive: false });
canvas.addEventListener('keydown', event => {
  if (control.owner === 'human' && ['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) {
    event.preventDefault(); input({ type: 'key', key: event.key });
  }
});
for (const button of document.querySelectorAll('[data-key]')) button.addEventListener('click', () => input({ type: 'key', key: button.dataset.key }));
$('#text-form').addEventListener('submit', event => { event.preventDefault(); if ($('#text').value) input({ type: 'text', value: $('#text').value }); });
window.nativeViewer = { state: () => ({ sessionId: session?.id, control: { ...control }, client: client?.state,
  frame: lastFrame ? { id: lastFrame.frameId, revision: lastFrame.revision } : null }), reconnect: () => client?.connect() };
window.addEventListener('pagehide', () => { client?.stop(); });
buttons();
try {
  const stored = sessionStorage.getItem('vd-native-viewer');
  if (stored) {
    busy = true; buttons();
    const saved = JSON.parse(stored);
    const response = await fetch(`/api/sessions/${saved.id}/observe`, { headers: { Authorization: `Bearer ${saved.viewerToken}` } });
    const observed = await response.json();
    if (!response.ok) throw new Error(observed.error.message);
    await attachSession({ ...saved, owner: observed.control.owner, epoch: observed.control.epoch });
  }
} catch (error) {
  sessionStorage.removeItem('vd-native-viewer'); session = null; notice(`Previous session could not be restored: ${error.message}`, true);
} finally { busy = false; buttons(); }
