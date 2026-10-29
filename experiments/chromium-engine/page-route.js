// Chromium's inspector_set_layer_tree_id::Data associates the DevTools frame
// with ChromeClient::GetLayerTreeId. Native tree_id is the same host_impl id.
// An about:blank widget can share the destination renderer PID; PID alone is
// insufficient to choose its records after a cross-document commit.
export function nativePageRoute(events, url, frameId, { browserPid, currentInventory } = {}) {
  const wanted = new URL(url); wanted.hash = '';
  const matches = value => { try { const candidate = new URL(value); candidate.hash = ''; return candidate.href === wanted.href; } catch { return false; } };
  const metadata = event => event.cat?.split(',').includes('disabled-by-default-devtools.timeline');
  const commits = events.flatMap((event, eventIndex) => event.name === 'FrameCommittedInBrowser' && metadata(event) &&
    (!browserPid || event.pid === browserPid) && event.args?.data?.frame === frameId && matches(event.args.data.url) && Number.isFinite(event.ts)
    ? [{ eventIndex, ts: event.ts, data: event.args.data }] : []).sort((a, b) => b.ts - a.ts);
  const latestCommit = commits[0];
  if (!latestCommit || commits.some(item => item.ts === latestCommit.ts && item.data.processId !== latestCommit.data.processId))
    throw new Error('Main-frame renderer provenance is ambiguous');
  const declaredPid = Number.isSafeInteger(latestCommit.data.processId) && latestCommit.data.processId > 0 ? latestCommit.data.processId : null;
  const ready = events.flatMap((event, eventIndex) => event.name === 'ProcessReadyInBrowser' && metadata(event) &&
    (!browserPid || event.pid === browserPid) && event.args?.data?.frame === frameId && Number.isFinite(event.ts) && event.ts >= latestCommit.ts &&
    Number.isSafeInteger(event.args.data.processId) && event.args.data.processId > 0
    ? [{ eventIndex, ts: event.ts, processId: event.args.data.processId }] : []);
  const readyPids = [...new Set(ready.map(item => item.processId))];
  let inventoryPid;
  if (currentInventory) {
    const pids = [...new Set(currentInventory.flatMap(event => event.name === 'TracingStartedInBrowser' && metadata(event) &&
      (!browserPid || event.pid === browserPid) && Number.isFinite(event.ts) && event.ts >= latestCommit.ts
      ? (event.args?.data?.frames || []).filter(frame => frame.frame === frameId && matches(frame.url) && Number.isSafeInteger(frame.processId) && frame.processId > 0)
        .map(frame => frame.processId) : []))];
    if (pids.length !== 1 || declaredPid && declaredPid !== pids[0]) throw new Error('Current main-frame inventory provenance is missing or contradictory');
    inventoryPid = pids[0];
  }
  // Browser commits may precede process readiness. FillFrameData then posts
  // ProcessReadyInBrowser; don't infer a PID from overlapping layout events.
  const trees = events.flatMap((event, eventIndex) => {
    const data = event.args?.data;
    return event.name === 'SetLayerTreeId' && metadata(event) && Number.isSafeInteger(event.pid) && event.pid > 0 &&
      event.pid !== browserPid && data?.frame === frameId &&
      Number.isSafeInteger(data.layerTreeId) && data.layerTreeId > 0 && Number.isFinite(event.ts)
      ? [{ eventIndex, pid: event.pid, ts: event.ts, treeId: data.layerTreeId }] : [];
  }).sort((a, b) => b.ts - a.ts);
  const boundPid = inventoryPid ?? declaredPid ?? (readyPids.length === 1 ? readyPids[0] : null);
  if (!boundPid) throw new Error('Main-frame renderer readiness provenance is missing or ambiguous');
  const eligible = trees.filter(item => item.ts >= latestCommit.ts && (!boundPid || item.pid === boundPid));
  const pids = [...new Set(eligible.map(item => item.pid))];
  if (pids.length !== 1) throw new Error('Main-frame renderer provenance is missing or ambiguous');
  const pid = pids[0], current = eligible[0];
  if (eligible.some(item => item.ts === current.ts && item.treeId !== current.treeId))
    throw new Error('Main-frame compositor widget provenance is missing or ambiguous');
  return { rendererPids: [pid], evidence: [{ eventIndex: latestCommit.eventIndex, name: 'FrameCommittedInBrowser', frame: frameId, url: latestCommit.data.url,
    processId: pid, browserEventProcessId: declaredPid, processIdSource: inventoryPid ? 'post-navigation-browser-inventory' : declaredPid ? 'browser-commit' : 'browser-process-ready' }],
    processReadyEvidence: ready.filter(item => item.processId === pid),
    route: { pid, treeId: current.treeId }, frameId,
    retiredTreeIds: [...new Set(trees.filter(item => item.pid === pid && item.treeId !== current.treeId).map(item => item.treeId))],
    layerTreeEvidence: trees.filter(item => item.pid === pid).slice(0, 32) };
}
