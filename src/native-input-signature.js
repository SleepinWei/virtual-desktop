import { createHash } from 'node:crypto';

// Conservative native drawing coverage, never DOM geometry. Every picture is
// clipped to its bounds by the renderer; transformed AABBs and a two-pixel
// margin overestimate coverage, including rounded corners and antialiasing.
export function pointerSignature(frame, action) {
  const { x, y } = action;
  if (action.type !== 'pointer' || !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x >= frame.viewport.width || y >= frame.viewport.height) return null;
  const intersects = (a, b) => {
    const left = Math.max(a[0], b[0]), top = Math.max(a[1], b[1]);
    const right = Math.min(a[0] + a[2], b[0] + b[2]), bottom = Math.min(a[1] + a[3], b[1] + b[3]);
    return right < left || bottom < top ? null : [left, top, right - left, bottom - top];
  };
  const hit = rect => rect && x >= rect[0] - 2 && y >= rect[1] - 2 && x <= rect[0] + rect[2] + 2 && y <= rect[1] + rect[3] + 2;
  const multiply = (a, b) => [a[0]*b[0]+a[1]*b[3], a[0]*b[1]+a[1]*b[4], a[0]*b[2]+a[1]*b[5]+a[2],
    a[3]*b[0]+a[4]*b[3], a[3]*b[1]+a[4]*b[4], a[3]*b[2]+a[4]*b[5]+a[5]];
  const mapped = (r, m) => {
    const points = [[r[0],r[1]],[r[0]+r[2],r[1]],[r[0],r[1]+r[3]],[r[0]+r[2],r[1]+r[3]]];
    const xs = points.map(([x,y]) => m[0]*x+m[1]*y+m[2]), ys = points.map(([x,y]) => m[3]*x+m[4]*y+m[5]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys)];
  };
  const surfaces = new Map(frame.surfaces.map(surface => [surface.id, surface])), drawing = [];
  function visit(id, matrix, parentClip) {
    const surface = surfaces.get(id), clip = intersects(parentClip, mapped(surface.rect, matrix));
    if (!hit(clip)) return;
    drawing.push(['surface', surface.id, surface.rect, surface.isolated ?? false]);
    for (const item of surface.items) {
      let visible = clip;
      if (item.clipped) visible = intersects(visible, mapped(item.clip, matrix));
      if (!visible) continue;
      if (item.roundedClip) visible = intersects(visible, mapped(item.roundedClip.slice(0, 4), matrix));
      if (!visible) continue;
      const t = item.transform, child = multiply(matrix, [t[0],t[1],t[3],t[4],t[5],t[7]]);
      const bounds = item.kind === 'surface' ? surfaces.get(item.id).rect : item.bounds;
      if (!hit(intersects(visible, mapped(bounds, child)))) continue;
      drawing.push(item);
      if (item.kind === 'surface') visit(item.id, child, visible);
    }
  }
  visit(frame.root, [1,0,0,0,1,0], [0,0,frame.viewport.width,frame.viewport.height]);
  return createHash('sha256').update(JSON.stringify({ viewport: frame.viewport, background: frame.background,
    producer: [frame.native?.pid, frame.native?.treeId], scroll: frame.scrollOffsets, drawing })).digest('hex');
}
