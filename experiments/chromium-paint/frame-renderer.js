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
              const m = item.transform;
              canvas.concat([m[0], m[1], m[3], m[4], m[5], m[7], 0, 0, 1]);
              const bounds = item.kind === 'surface' ? surfaces.get(item.id).rect : item.bounds;
              canvas.clipRect(rectangle(bounds), kit.ClipOp.Intersect, false);
              if (item.opacity < 1) {
                alphaPaint = new kit.Paint(); alphaPaint.setAlphaf(item.opacity);
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
      drawSurface(frame.root);
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
