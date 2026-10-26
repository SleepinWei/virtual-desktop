export function drawScene(canvas, scene) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = scene.viewport.width, height = scene.viewport.contentHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.fillStyle = '#f0f4fa'; ctx.fillRect(0, 0, width, height);
  for (const command of scene.commands) {
    ctx.save();
    if (command.op === 'rect') {
      ctx.beginPath();
      ctx.roundRect(command.x, command.y, command.width, command.height, command.radius || 0);
      ctx.fillStyle = command.fill; ctx.fill();
      if (command.strokeWidth) { ctx.strokeStyle = command.stroke; ctx.lineWidth = command.strokeWidth; ctx.stroke(); }
    } else if (command.op === 'text') {
      ctx.beginPath(); ctx.rect(command.x, command.y - command.height / 2, command.width, command.height); ctx.clip();
      ctx.font = `${command.fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'middle'; ctx.fillStyle = command.fill;
      ctx.fillText(command.text, command.x, command.y, command.width);
    } else if (command.op === 'path') {
      ctx.beginPath();
      command.points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.strokeStyle = command.stroke; ctx.lineWidth = command.strokeWidth; ctx.stroke();
    } else throw new Error('Unsupported draw command');
    ctx.restore();
  }
  canvas.dataset.ready = 'true';
  canvas.dataset.seq = String(scene.seq);
}
