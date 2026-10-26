import { applyFrame } from '/protocol.js';
import { drawScene } from '/renderer.js';

const $ = selector => document.querySelector(selector);
const sessions = [];
let current, generation = 0, selectedInput = null;
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function admin() { return $('#admin-token').value; }
async function api(path, credential, method = 'GET', payload) {
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${credential}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
  return { data, bytes: new TextEncoder().encode(JSON.stringify(data)).byteLength };
}
function route(s, operation) { return `/api/sessions/${s.id}/${operation}`; }
function controls() {
  const active = current?.state === 'ACTIVE';
  $('#run-agent').disabled = !active || current.owner !== 'agent';
  $('#take-control').disabled = !active || current.owner === 'human';
  $('#release-control').disabled = !active || current.owner !== 'human';
  $('#save-close').disabled = !active;
  $('#resume').disabled = current?.state !== 'COLD';
  $('#mode').textContent = current?.owner === 'human' ? 'Human control' : 'Read only / agent control';
  $('#remote-input').disabled = !active || current.owner !== 'human' || !selectedInput;
  $('#send-input').disabled = $('#remote-input').disabled;
}
function list() {
  $('#sessions').replaceChildren();
  sessions.forEach((session, index) => {
    const button = document.createElement('button');
    button.className = `session${session === current ? ' selected' : ''}`;
    button.dataset.sessionId = session.id;
    button.textContent = `Workspace ${index + 1}`;
    const small = document.createElement('small');
    small.textContent = `${session.id.slice(0, 8)} · ${session.state}`;
    button.append(small); button.addEventListener('click', () => select(session));
    $('#sessions').append(button);
  });
}
async function poll(s, selectedGeneration) {
  if (s !== current || selectedGeneration !== generation || s.state !== 'ACTIVE') return;
  try {
    const result = await api(`${route(s, 'frame')}${s.scene ? `?since=${s.scene.seq}` : ''}`, s.viewerToken);
    if (selectedGeneration !== generation) return;
    const frame = result.data;
    Object.assign(s, frame.control);
    if (frame.type !== 'unchanged') {
      s.scene = applyFrame(s.scene, frame);
      drawScene($('#desktop'), s.scene);
      $('#frame-kind').textContent = frame.type;
      $('#frame-stats').textContent = `${frame.seq} / ${result.bytes.toLocaleString()} B`;
    }
    $('#connection').textContent = `Connected · ${s.id.slice(0, 8)}`;
    controls();
  } catch (error) { if (selectedGeneration === generation) { notice(error.message, true); $('#connection').textContent = 'Connection error'; } }
  if (selectedGeneration === generation) setTimeout(() => poll(s, selectedGeneration), 350);
}
function select(s) {
  current = s; generation++; selectedInput = null;
  $('#session-title').textContent = `Workspace ${sessions.indexOf(s) + 1}`;
  $('#remote-input').value = '';
  if (s.scene) drawScene($('#desktop'), s.scene);
  else { const canvas = $('#desktop'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); delete canvas.dataset.ready; }
  list(); controls();
  if (s.state === 'ACTIVE') poll(s, generation);
  else $('#connection').textContent = 'Saved / no execution process';
}
async function perform(s, action, human = false) {
  const { data } = await api(route(s, 'actions'), human ? s.humanToken : s.agentToken, 'POST', { epoch: s.epoch, actionId: crypto.randomUUID(), action });
  return data;
}
function handler(selector, fn) {
  $(selector).addEventListener('click', async () => {
    try { await fn(); } catch (error) { notice(error.message, true); }
  });
}
handler('#create-session', async () => {
  $('#create-session').disabled = true;
  try {
    const { data } = await api('/api/sessions', admin(), 'POST', {});
    sessions.push(data); select(data); notice('Session ready. Viewer uses a read-only capability.');
  } finally { $('#create-session').disabled = false; }
});
handler('#run-agent', async () => {
  const s = current;
  await perform(s, { type: 'fill', selector: '#task-input', value: 'Submitted by the example agent' });
  await perform(s, { type: 'click', selector: '#add-task' });
  await perform(s, { type: 'click', selector: '#increment' });
  notice('Agent filled the form, added a task, and incremented the counter.');
});
handler('#take-control', async () => {
  const s = current;
  const { data } = await api(route(s, 'control'), s.humanToken, 'POST', { epoch: s.epoch, owner: 'human' });
  Object.assign(s, data); controls(); notice('Human control acquired. Previous agent writes are rejected.');
});
handler('#release-control', async () => {
  const s = current;
  const { data } = await api(route(s, 'control'), s.humanToken, 'POST', { epoch: s.epoch, owner: 'agent' });
  Object.assign(s, data); selectedInput = null; controls(); notice('Control returned. Agent must use the new epoch.');
});
handler('#save-close', async () => {
  const s = current;
  const { data } = await api(route(s, 'release'), admin(), 'POST', { save: true });
  Object.assign(s, data); generation++; list(); controls(); $('#connection').textContent = 'Saved / no execution process';
  notice('Profile saved. Execution process has been released.');
});
handler('#resume', async () => {
  const old = current;
  const { data } = await api('/api/sessions', admin(), 'POST', { profileId: old.profileId });
  sessions.splice(sessions.indexOf(old), 1, data); select(data); notice('Profile restored into a new execution process.');
});
$('#desktop').addEventListener('click', async event => {
  const s = current;
  if (!s?.scene || s.owner !== 'human') return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) * s.scene.viewport.width / rect.width;
  const y = (event.clientY - rect.top) * s.scene.viewport.contentHeight / rect.height;
  const target = [...s.scene.targets].reverse().find(t => x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height);
  if (!target) return;
  try {
    await perform(s, { type: 'pointer', x, y, seq: s.scene.seq }, true);
    selectedInput = target.tag === 'input' ? target.selector : null;
    if (selectedInput) { $('#remote-input').value = target.value; $('#remote-input').focus(); }
    controls();
  } catch (error) { notice(error.message, true); }
});
$('#input-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedInput || current?.owner !== 'human') return;
  try { await perform(current, { type: 'fill', selector: selectedInput, value: $('#remote-input').value }, true); notice('Remote input updated. Click Add task in the canvas to submit.'); }
  catch (error) { notice(error.message, true); }
});
