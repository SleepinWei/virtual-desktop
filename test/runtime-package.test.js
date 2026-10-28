import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectRuntimeFiles } from '../experiments/chromium-engine/package-runtime.js';
import { sha256, verifyArtifacts } from '../experiments/chromium-engine/artifacts.js';

test('runtime selection retains engine dependencies and rejects unreviewed or escaping paths', () => {
  const selected = selectRuntimeFiles(['./headless_shell', 'icudtl.dat', './libblink_core.dylib', 'snapshot_blob.bin',
    'gen/third_party/devtools-frontend/a.js', 'pyproto/google/protobuf/a.py', 'angledata/VkLayer_khronos_validation.json', './libblink_core.dylib']);
  assert.deepEqual(selected.included, ['headless_shell', 'icudtl.dat', 'libblink_core.dylib', 'snapshot_blob.bin']);
  assert.equal(selected.excluded.length, 3);
  for (const path of ['../lib.dylib', '/tmp/lib.dylib', 'a/../../lib.dylib', 'obj/test.o', 'cc_unittests', 'other/runtime.dat']) {
    assert.throws(() => selectRuntimeFiles(['headless_shell', 'icudtl.dat', path]), /Unsafe|Unreviewed/);
  }
  assert.throws(() => selectRuntimeFiles(['headless_shell']), /Incomplete/);
});

test('relocatable runtime still rejects changed libraries, unknown formats and escaped executable paths', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'runtime-package-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'original'), moved = join(parent, 'moved');
  const directory = 'chromium/src/out/VirtualDesktop';
  await mkdir(join(root, directory), { recursive: true });
  const artifacts = {};
  for (const name of ['headless_shell', 'libcc.dylib', 'libcc_base.dylib', 'libcc_paint.dylib', 'libblink_platform.dylib', 'libcomponents_viz_service.dylib']) {
    await writeFile(join(root, directory, name), 'synthetic fixture: ' + name);
    artifacts[name] = await sha256(join(root, directory, name));
  }
  const state = { distributionFormat: 'native-runtime-v1', binary: directory + '/headless_shell', artifacts, binarySha256: artifacts.headless_shell };
  await verifyArtifacts(state, root);
  await rename(root, moved);
  await verifyArtifacts(state, moved);
  await assert.rejects(verifyArtifacts({ ...state, binary: '../headless_shell' }, moved), /outside/);
  await assert.rejects(verifyArtifacts({ ...state, distributionFormat: 'unknown' }, moved), /outside/);
  await writeFile(join(moved, directory, 'libcc.dylib'), 'changed');
  await assert.rejects(verifyArtifacts(state, moved), /checksum differs/);
});
