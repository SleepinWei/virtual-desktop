import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArtifacts(state, root) {
  const binary = join(resolve(root), 'chromium/src/out/VirtualDesktop/headless_shell');
  if (state.binary !== binary) throw new Error('Executable is outside the pinned build output');
  const artifacts = state.artifacts;
  for (const required of ['headless_shell', 'libcc.dylib', 'libcc_base.dylib', 'libcc_paint.dylib', 'libblink_platform.dylib']) {
    if (!artifacts || !Object.hasOwn(artifacts, required)) throw new Error('Missing component fingerprint: ' + required);
  }
  if (artifacts.headless_shell !== state.binarySha256) throw new Error('Executable fingerprints disagree');
  for (const [name, expected] of Object.entries(artifacts)) {
    if (!/^[A-Za-z0-9_.+-]+$/.test(name) || ['.', '..'].includes(name) || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error('Invalid build artifact fingerprint');
    }
    if (await sha256(join(dirname(binary), name)) !== expected) {
      throw new Error('Build artifact checksum differs: ' + name);
    }
  }
  return artifacts;
}
