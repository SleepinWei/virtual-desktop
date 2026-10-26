import { randomUUID } from 'node:crypto';

export class AgentClient {
  constructor(baseUrl, session) { this.baseUrl = baseUrl; this.session = session; }
  async call(operation, method = 'GET', body) {
    const response = await fetch(`${this.baseUrl}/api/sessions/${this.session.id}/${operation}`, {
      method, headers: { Authorization: `Bearer ${this.session.agentToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error.message), { code: data.error.code, status: response.status });
    return data;
  }
  async observe() {
    const observation = await this.call('observe');
    this.session.epoch = observation.control.epoch;
    return observation;
  }
  action(action, actionId = randomUUID()) { return this.call('actions', 'POST', { actionId, epoch: this.session.epoch, action }); }
  fill(selector, value) { return this.action({ type: 'fill', selector, value }); }
  click(selector) { return this.action({ type: 'click', selector }); }
}
