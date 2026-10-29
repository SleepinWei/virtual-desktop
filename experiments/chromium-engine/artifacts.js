import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const COMPONENT_DIRECTORY = 'chromium/src/out/VirtualDesktop';
export const LEAN_DIRECTORY = 'chromium/src/out/VirtualDesktopLeanNinja';
export const MONOLITHIC_FORMAT = 'native-runtime-monolithic-v1';
export const MONOLITHIC_REQUIRED = ['headless_shell', 'icudtl.dat', 'snapshot_blob.bin',
  'v8_context_snapshot.arm64.bin', 'headless_lib_data.pak', 'headless_lib_strings.pak'];

export function artifactLayout(state, root) {
  const monolithic = state.engineLayout === 'monolithic';
  if (state.engineLayout && !['component', 'monolithic'].includes(state.engineLayout)) throw new Error('Unknown engine layout');
  const format = monolithic ? MONOLITHIC_FORMAT : 'native-runtime-v1';
  const packaged = state.distributionFormat === format && state.binary === COMPONENT_DIRECTORY + '/headless_shell';
  const directory = join(resolve(root), monolithic && !packaged ? LEAN_DIRECTORY : COMPONENT_DIRECTORY);
  const binary = join(directory, 'headless_shell');
  if ((!packaged && (state.distributionFormat || state.binary !== binary))) throw new Error('Executable is outside the pinned build output');
  return { binary, directory, monolithic, packaged };
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArtifacts(state, root) {
  const { binary, monolithic, packaged } = artifactLayout(state, root);
  if (monolithic) {
    const profile = await sha256(new URL('./lean-mac-arm64.gn', import.meta.url));
    const profilePath = packaged ? join(root, 'chromium/lean-profile.gn') : join(dirname(binary), 'args.gn');
    if (state.profileSha256 !== profile || await sha256(profilePath) !== profile) throw new Error('Monolithic profile fingerprint differs');
  }
  const artifacts = state.artifacts;
  const requiredFiles = monolithic ? MONOLITHIC_REQUIRED :
    ['headless_shell', 'libcc.dylib', 'libcc_base.dylib', 'libcc_paint.dylib', 'libblink_platform.dylib', 'libcomponents_viz_service.dylib'];
  for (const required of requiredFiles) {
    if (!artifacts || !Object.hasOwn(artifacts, required)) throw new Error('Missing ' + (monolithic ? 'monolithic' : 'component') + ' fingerprint: ' + required);
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
