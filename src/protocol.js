export const PROTOCOL_VERSION = 1;

export function diffScene(previous, current) {
  if (!previous) return { type: 'snapshot', ...current };
  const old = new Map(previous.commands.map(command => [command.id, command]));
  const fresh = new Set(current.commands.map(command => command.id));
  return {
    type: 'delta', version: PROTOCOL_VERSION, baseSeq: previous.seq,
    seq: current.seq, viewport: current.viewport,
    upserts: current.commands.filter(command => JSON.stringify(old.get(command.id)) !== JSON.stringify(command)),
    removes: [...old.keys()].filter(id => !fresh.has(id)),
    order: current.commands.map(command => command.id),
    targets: current.targets,
  };
}

export function applyFrame(scene, frame) {
  if (frame.type === 'snapshot') {
    const { type, ...snapshot } = frame;
    return structuredClone(snapshot);
  }
  if (!scene || frame.baseSeq !== scene.seq) throw new Error('FRAME_BASE_MISMATCH');
  const commands = new Map(scene.commands.map(command => [command.id, command]));
  for (const id of frame.removes) commands.delete(id);
  for (const command of frame.upserts) commands.set(command.id, command);
  return {
    version: frame.version, seq: frame.seq, viewport: frame.viewport,
    commands: frame.order.map(id => {
      if (!commands.has(id)) throw new Error('FRAME_COMMAND_MISSING');
      return commands.get(id);
    }),
    targets: frame.targets,
  };
}
