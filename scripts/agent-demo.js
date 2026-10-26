import { AgentClient } from '../src/client.js';

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8080';
const admin = process.env.ADMIN_TOKEN || 'dev-local';
const response = await fetch(`${baseUrl}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{}' });
const session = await response.json();
if (!response.ok) throw new Error(JSON.stringify(session));
try {
  const agent = new AgentClient(baseUrl, session);
  await agent.fill('#task-input', 'Completed with no viewer attached');
  await agent.click('#add-task');
  await agent.click('#increment');
  const observation = await agent.observe();
  console.log(JSON.stringify({ sessionId: session.id, profileId: session.profileId, seq: observation.seq, text: observation.text }, null, 2));
} finally {
  const released = await fetch(`${baseUrl}/api/sessions/${session.id}/release`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{"save":true}' });
  if (!released.ok) throw new Error(`Session release failed: ${released.status}`);
}
