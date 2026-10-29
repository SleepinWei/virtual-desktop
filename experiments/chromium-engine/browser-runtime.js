// Explicit macOS diagnostic/workaround only. GPU faults now affect the browser
// process; this does not validate the normal separate-GPU process path.
export function imageAnimationArgs(policy) {
  if (policy === undefined) return [];
  if (policy === 'first-frame') return ['--blink-settings=imageAnimationPolicy=2'];
  throw new Error('Unsupported image animation policy');
}

export function browserProcessArgs({ mode = process.env.VIRTUAL_DESKTOP_MAC_GPU_MODE ?? 'separate', platform = process.platform } = {}) {
  if (mode === 'separate') return [];
  if (mode === 'in-process' && platform === 'darwin') return ['--in-process-gpu'];
  throw new Error('Unsupported GPU process mode/platform');
}

export function nativeWorkerEnvironment(env = process.env, platform = process.platform) {
  const selected = { PATH: env.PATH, NODE_ENV: 'production' };
  if (env.VIRTUAL_DESKTOP_MAC_GPU_MODE !== undefined) {
    browserProcessArgs({ mode: env.VIRTUAL_DESKTOP_MAC_GPU_MODE, platform });
    selected.VIRTUAL_DESKTOP_MAC_GPU_MODE = env.VIRTUAL_DESKTOP_MAC_GPU_MODE;
  }
  return selected;
}
