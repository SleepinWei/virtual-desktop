import { createHash } from 'node:crypto';

export const siteWorkloads = {
  example: { kind: 'focus', description: 'Tab / Shift+Tab; no navigation or form submission' },
  iana: { kind: 'focus', description: 'Tab / Shift+Tab; no navigation or form submission' },
  cern: { kind: 'focus', description: 'Tab / Shift+Tab; no navigation or form submission' },
  hackernews: { kind: 'input', selector: 'input[name="q"]', description: 'Edit the search box locally; no submission' },
  python: { kind: 'input', selector: '#id-search-field', description: 'Edit the search box locally; no submission' },
  bilibili: { kind: 'input', selector: 'input.nav-search-input', description: 'Edit the search box locally; no submission or playback' },
};
export function siteAction(workload, index) {
  if (workload.kind === 'input') return { type: 'fill', selector: workload.selector, value: `virtual desktop ${index % 2}` };
  return { type: 'key', key: 'Tab', modifiers: index % 2 ? ['Shift'] : [] };
}
export function percentile(values, fraction) {
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
}
export function measureProcesses(start, end, samples = []) {
  const before = new Map(start.processes.map(row => [row.pid, row.cpuSeconds])), latest = new Map();
  const all = [start, ...samples, end];
  for (const sample of all) for (const row of sample.processes)
    latest.set(row.pid, Math.max(latest.get(row.pid) || 0, row.cpuSeconds));
  return { processCpuSeconds: [...latest].reduce((sum, [pid, seconds]) => sum + Math.max(0, seconds - (before.get(pid) || 0)), 0),
    peakSummedRssBytes: Math.max(...all.map(sample => sample.treeRssBytes)),
    newHostSwapoutBytes: Math.max(...all.map(sample => sample.swapoutBytes)) - start.swapoutBytes,
    minHostFreePercent: Math.min(...all.map(sample => sample.freePercent)) };
}
export async function pageSnapshot(page, workload) {
  const state = await page.evaluate(selector => {
    const element = selector ? document.querySelector(selector) : document.activeElement;
    const bounds = element?.getBoundingClientRect();
    return { title: document.title, url: location.href, text: document.body.innerText, readyState: document.readyState,
      images: { total: document.images.length, loaded: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length },
      frames: document.querySelectorAll('iframe').length,
      scroll: { x: scrollX, y: scrollY, height: document.documentElement.scrollHeight },
      target: element ? { tag: element.tagName.toLowerCase(), id: element.id, name: element.getAttribute('name'),
        value: element.value ?? null, focused: document.activeElement === element,
        bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null } : null };
  }, workload.selector);
  const text = state.text; delete state.text;
  return { ...state, textLength: text.length, textSha256: createHash('sha256').update(text).digest('hex') };
}
export async function attachSiteAudit(page, cdp) {
  const data = { requests: 0, failedRequests: 0, encodedResponseBytes: 0, responseHosts: {}, failedHosts: {}, pageErrors: [] };
  page.on('request', () => data.requests++);
  page.on('requestfailed', request => {
    const host = new URL(request.url()).hostname;
    data.failedRequests++; data.failedHosts[host] = (data.failedHosts[host] || 0) + 1;
  });
  page.on('response', response => { const host = new URL(response.url()).hostname; data.responseHosts[host] = (data.responseHosts[host] || 0) + 1; });
  page.on('pageerror', error => { if (data.pageErrors.length < 8) data.pageErrors.push(error.message.slice(0, 180)); });
  cdp.on('Network.loadingFinished', event => data.encodedResponseBytes += event.encodedDataLength);
  await cdp.send('Network.enable');
  return data;
}
export function comparablePair(ordinary, native) {
  return ordinary?.status === 'passed' && native?.status === 'passed' &&
    ordinary.operations === native.operations && native.freshNativeFrames === native.operations &&
    ordinary.finalState.textSha256 === native.finalState.textSha256 &&
    ordinary.finalState.target?.value === native.finalState.target?.value &&
    ordinary.finalState.scroll.y === native.finalState.scroll.y;
}
export function acceptedVisualStages(stages) {
  return stages.length === 2 && stages.every(stage => stage.passed && stage.controlJpegQuality?.passed);
}
