import { findPageProvenance } from '../chromium-paint/capture.js';

// Chromium's inspector_set_layer_tree_id::Data associates the DevTools frame
// with ChromeClient::GetLayerTreeId. Native tree_id is the same host_impl id.
// An about:blank widget can share the destination renderer PID; PID alone is
// insufficient to choose its records after a cross-document commit.
export function nativePageRoute(events, url, frameId) {
  const evidence = findPageProvenance(events, url).evidence.filter(item => item.frame === frameId && item.processId > 0);
  const commits = evidence.filter(item => item.name === 'FrameCommittedInBrowser' && Number.isFinite(events[item.eventIndex].ts));
  const latestCommit = commits.sort((a, b) => events[b.eventIndex].ts - events[a.eventIndex].ts)[0];
  if (latestCommit && commits.some(item => events[item.eventIndex].ts === events[latestCommit.eventIndex].ts && item.processId !== latestCommit.processId))
    throw new Error('Main-frame renderer provenance is ambiguous');
  const pids = latestCommit ? [latestCommit.processId] : [...new Set(evidence.map(item => item.processId))];
  if (pids.length !== 1) throw new Error('Main-frame renderer provenance is missing or ambiguous');
  const pid = pids[0], commitTime = latestCommit ? events[latestCommit.eventIndex].ts : -Infinity;
  const trees = events.flatMap((event, eventIndex) => {
    const data = event.args?.data;
    return event.name === 'SetLayerTreeId' && event.pid === pid && data?.frame === frameId &&
      Number.isSafeInteger(data.layerTreeId) && data.layerTreeId > 0 && Number.isFinite(event.ts)
      ? [{ eventIndex, ts: event.ts, treeId: data.layerTreeId }] : [];
  }).sort((a, b) => b.ts - a.ts);
  const current = trees[0];
  if (!current || current.ts < commitTime || trees.some(item => item.ts === current.ts && item.treeId !== current.treeId))
    throw new Error('Main-frame compositor widget provenance is missing or ambiguous');
  return { rendererPids: [pid], evidence: evidence.filter(item => item.processId === pid),
    route: { pid, treeId: current.treeId }, frameId,
    retiredTreeIds: [...new Set(trees.filter(item => item.treeId !== current.treeId).map(item => item.treeId))],
    layerTreeEvidence: trees.slice(0, 32) };
}
