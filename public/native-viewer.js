import { NativeClient } from '/native-client.js';
import { captureNativeInput } from '/native-input.js';

const $ = selector => document.querySelector(selector), canvas = $('#desktop');
let session, client, kit, control = { owner: 'agent', epoch: 1 }, busy = false, draining = false, lastFrame, connectionStatus;
const inputs = [];
const inputStats = { accepted: 0, rejected: 0, pointers: 0, lastError: null };
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function buttons() {
  const active = session?.state === 'ACTIVE', human = active && control.owner === 'human';
  $('#create').disabled = busy || active;
  $('#take').disabled = busy || !active || human; $('#return').disabled = busy || !active || !human;
  $('#close').disabled = busy || !active; $('#reconnect').disabled = busy || !active;
  $('#owner').textContent = `${human ? 'You own' : 'Agent owns'} input · control ${control.epoch}`;
}
function mergeControl(value) {
  if (value?.epoch >= control.epoch) {
    if (value.epoch !== control.epoch || value.owner !== 'human') { inputs.length = 0; keyboard.reset(); }
    control = value; buttons();
  }
}
async function attachSession(value) {
  kit ||= await window.CanvasKitInit({ locateFile: file => '/native-runtime/' + file });
  session = value; control = { owner: value.owner, epoch: value.epoch };
  if ([...$('#fixture').options].some(option => option.value === value.fixture)) $('#fixture').value = value.fixture;
  sessionStorage.setItem('vd-native-viewer', JSON.stringify(session));
  $('#session').textContent = `Chromium session ${session.id.slice(0, 8)}`;
  client = new NativeClient({ kit, canvas, session,
    onControl: mergeControl,
    onStatus(status, message) {
      const changed = status !== connectionStatus; connectionStatus = status;
      $('#connection').textContent = message; $('#connection').classList.toggle('error', status === 'error');
      document.documentElement.dataset.connection = status;
      if (status === 'ended') { inputs.length = 0; keyboard.reset(); session.state = 'FAILED'; sessionStorage.removeItem('vd-native-viewer'); buttons(); }
      if (changed && status === 'connected') notice('Live frame ready. Reconnecting the viewer keeps this Chromium page alive.');
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
  if (control.owner !== 'human' || session?.state !== 'ACTIVE') return;
  if (!client?.presented) { notice('Wait for a complete frame before sending input.', true); return; }
  if (action.type === 'wheel' && !client.coordinateReady) {
    inputStats.rejected++; inputStats.lastError = 'FRAME_CATCHING_UP';
    notice('The page is catching up. Wait for the current frame before clicking.'); return;
  }
  if (inputs.length >= 64) { notice('Input queue is full. Wait for the page to catch up.', true); return; }
  const last = inputs.at(-1);
  if (action.type === 'text' && last?.action.type === 'text' && last.epoch === control.epoch && last.action.value.length + action.value.length <= 2000) last.action.value += action.value;
  else inputs.push({ sessionId: session.id, epoch: control.epoch, action: { ...action }, shown: { ...client.presented } });
  if (draining) return;
  draining = true;
  try {
    while (inputs.length) {
      const next = inputs.shift();
      if (next.sessionId !== session?.id || next.epoch !== control.epoch || control.owner !== 'human') continue;
      if (!client?.presented) { inputs.length = 0; notice('Connection interrupted; input stopped. Reconnect before typing.', true); break; }
      const shown = ['pointer', 'wheel'].includes(next.action.type) ? next.shown : client.presented;
      await request('actions', { epoch: next.epoch, actionId: crypto.randomUUID(), action: { ...next.action, ...shown } });
      inputStats.accepted++; if (next.action.type === 'pointer') inputStats.pointers++;
      if (inputStats.lastError) { inputStats.lastError = null; notice('Input delivered. Escape returns focus to the toolbar.'); }
    }
  } catch (error) {
    inputs.length = 0;
    inputStats.rejected++; inputStats.lastError = error.code || 'INPUT_ERROR';
    notice(error.code === 'STALE_FRAME' ? 'The page changed. Click the field again before typing.' : error.message, true);
  } finally { draining = false; }
}
const keyboard = captureNativeInput({ canvas, sink: $('#keyboard-input'), enabled: () => control.owner === 'human' && session?.state === 'ACTIVE',
  send: input, leave: () => $('#return').focus(), onError: message => notice(message, true) });
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || session?.state === 'ACTIVE') return;
  busy = true; buttons(); $('#create').textContent = 'Starting Chromium…'; notice('Starting a verified native browser session…');
  try {
    const health = await (await fetch('/health')).json();
    if (!health.nativeAvailable) throw new Error('Native backend is not configured. Start the verified native service first.');
    if (health.nativeResources?.stop) throw new Error(`Host resource guard stopped this service (${health.nativeResources.stop}). Reduce load and restart the native service.`);
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
  try { mergeControl(await request('control', { epoch: control.epoch, owner })); notice(owner === 'human' ? 'Click a field in the page and type directly. Escape returns focus to the toolbar.' : 'Input returned to the agent.'); }
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
  try { inputs.length = 0; keyboard.reset(); await client.stop(); await request('release', { save: false }, $('#admin-token').value); session.state = 'COLD';
    sessionStorage.removeItem('vd-native-viewer');
    $('#connection').textContent = 'Session closed'; document.documentElement.dataset.connection = 'closed'; notice('The owned Chromium browser was stopped.'); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; buttons(); }
});
canvas.addEventListener('click', event => {
  const bounds = canvas.getBoundingClientRect();
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
window.nativeViewer = { state: () => ({ sessionId: session?.id, control: { ...control }, client: client?.state,
  pendingInputs: inputs.length + Number(draining), input: { ...inputStats }, frame: lastFrame ? { id: lastFrame.frameId, revision: lastFrame.revision } : null }),
  frame: () => lastFrame?.frame, reconnect: () => client?.connect() };
window.addEventListener('pagehide', () => { client?.stop(); });
buttons();
try {
  const health = await (await fetch('/health')).json();
  for (const target of health.externalTargets || []) {
    const option = [...$('#fixture').options].find(item => item.value === target); if (option) option.disabled = false;
  }
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
