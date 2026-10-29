// All pixels, opacity groups and transforms are evaluated in this local client.
export function createFramePainter(kit, visibleCanvas) {
  const buffer = document.createElement('canvas');
  let surface;
  const rectangle = rect => kit.XYWHRect(...rect);
  return {
    present(frame, pictures) {
      if (!surface || buffer.width !== frame.viewport.width || buffer.height !== frame.viewport.height) {
        surface?.dispose();
        buffer.width = frame.viewport.width; buffer.height = frame.viewport.height;
        surface = kit.MakeSWCanvasSurface(buffer);
        if (!surface) throw new Error('Could not allocate the local frame back buffer');
      }
      const canvas = surface.getCanvas(), surfaces = new Map(frame.surfaces.map(surface => [surface.id, surface]));
      canvas.clear(kit.Color4f(...frame.background));
      function drawSurface(id) {
        const target = surfaces.get(id);
        canvas.save();
        try {
          canvas.clipRect(rectangle(target.rect), kit.ClipOp.Intersect, false);
          for (const item of target.items) {
            canvas.save();
            let alphaPaint, layerSaved = false;
            try {
              if (item.clipped) canvas.clipRect(rectangle(item.clip), kit.ClipOp.Intersect, false);
              // Native masks are expressed in the target surface's space.
              if (item.roundedClip) {
                const r = item.roundedClip;
                canvas.clipRRect(Float32Array.of(r[0], r[1], r[0] + r[2], r[1] + r[3], ...r.slice(4)), kit.ClipOp.Intersect, true);
              }
              const m = item.transform;
              canvas.concat([m[0], m[1], m[3], m[4], m[5], m[7], 0, 0, 1]);
              const bounds = item.kind === 'surface' ? surfaces.get(item.id).rect : item.bounds;
              canvas.clipRect(rectangle(bounds), kit.ClipOp.Intersect, false);
              // Chromium rasterizes each picture into transparent layer
              // backing. Internal DstIn must affect that backing, preserving
              // the parent background. Rounded edges also apply once per group.
              if (item.kind === 'picture' || item.opacity < 1 || item.roundedClip || item.blendMode && item.blendMode !== 'SrcOver' ||
                  item.kind === 'surface' && surfaces.get(item.id).isolated) {
                alphaPaint = new kit.Paint(); alphaPaint.setAlphaf(item.opacity);
                if (item.blendMode) alphaPaint.setBlendMode(kit.BlendMode[item.blendMode]);
                canvas.saveLayer(alphaPaint, rectangle(bounds));
                layerSaved = true;
              }
              if (item.kind === 'surface') drawSurface(item.id);
              else if (item.kind === 'picture') canvas.drawPicture(pictures.get(item.resource));
              else {
                const paint = new kit.Paint();
                try { paint.setColor(kit.Color4f(...item.color)); canvas.drawRect(rectangle(item.bounds), paint); }
                finally { paint.delete(); }
              }
            } finally {
              if (layerSaved) canvas.restore();
              alphaPaint?.delete();
              canvas.restore();
            }
          }
        } finally { canvas.restore(); }
      }
      if (surfaces.get(frame.root).isolated) {
        canvas.saveLayer(null, rectangle(surfaces.get(frame.root).rect));
        try { drawSurface(frame.root); } finally { canvas.restore(); }
      } else drawSurface(frame.root);
      surface.flush();
      // Commit only after every layer has drawn successfully. A decoding error
      // or stale asynchronous load leaves the previously visible frame intact.
      if (visibleCanvas.width !== buffer.width) visibleCanvas.width = buffer.width;
      if (visibleCanvas.height !== buffer.height) visibleCanvas.height = buffer.height;
      const context = visibleCanvas.getContext('2d');
      context.save();
      context.globalCompositeOperation = 'copy'; context.drawImage(buffer, 0, 0);
      context.restore();
    },
    dispose() { surface?.dispose(); surface = null; },
  };
}
