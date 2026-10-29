import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectRuntimeFiles, auditMachOOutput } from '../experiments/chromium-engine/package-runtime.js';
import { sha256, verifyArtifacts, MONOLITHIC_REQUIRED, MONOLITHIC_FORMAT, LEAN_DIRECTORY } from '../experiments/chromium-engine/artifacts.js';
import { verifiedEngine } from '../experiments/chromium-engine/verified.js';

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

test('relative Mach-O self identities cannot hide relative or escaping load dependencies', () => {
  const names = ['headless_shell', 'libEGL.dylib', 'libGLESv2.dylib'];
  const output = '/runtime/libEGL.dylib:\n\t./libEGL.dylib (compatibility version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n' +
    '/runtime/libGLESv2.dylib:\n\t@rpath/libGLESv2.dylib (compatibility version 0.0.0)\n\t@rpath/libEGL.dylib (compatibility version 0.0.0)\n';
  const identities = { 'libEGL.dylib': './libEGL.dylib', 'libGLESv2.dylib': '@rpath/libGLESv2.dylib' };
  assert.equal(auditMachOOutput(output, names, identities).internalLibraries, 1);
  assert.throws(() => auditMachOOutput(output.replace('\t@rpath/libEGL', '\t./libEGL'), names, identities), /Unresolved/);
  assert.throws(() => auditMachOOutput(output.replace('\t@rpath/libEGL', '\t@rpath/../libEGL'), names, identities), /Unresolved/);
  assert.throws(() => auditMachOOutput(output.replace('\t/usr/lib/', '\t./libEGL.dylib (compatibility version 0.0.0)\n\t/usr/lib/'), names, identities), /Unresolved/);
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

test('monolithic packages bind the current profile and positive C++ evidence to their executable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'monolithic-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = 'chromium/src/out/VirtualDesktop';
  await mkdir(join(root, directory), { recursive: true });
  const artifacts = {};
  for (const name of MONOLITHIC_REQUIRED) {
    await writeFile(join(root, directory, name), 'synthetic monolithic fixture: ' + name);
    artifacts[name] = await sha256(join(root, directory, name));
  }
  const profile = await readFile(new URL('../experiments/chromium-engine/lean-mac-arm64.gn', import.meta.url));
  await writeFile(join(root, 'chromium/lean-profile.gn'), profile);
  const profileSha256 = await sha256(join(root, 'chromium/lean-profile.gn'));
  const source = JSON.parse(await readFile(new URL('../experiments/chromium-engine/source.json', import.meta.url), 'utf8'));
  const patchSha256 = await sha256(new URL('../experiments/chromium-engine/remote-paint.patch', import.meta.url));
  const state = { distributionFormat: MONOLITHIC_FORMAT, engineLayout: 'monolithic', binary: directory + '/headless_shell',
    artifacts, binarySha256: artifacts.headless_shell, profileSha256, revision: source.revision, patchSha256,
    compiled: true, ccTestsPassed: true, vizTestsPassed: true, exitCode: 0, stage: 'engine-tests-complete',
    cppTestsEvidence: { version: 1, revision: source.revision, binarySha256: artifacts.headless_shell, profileSha256,
      testArtifacts: { cc_unittests: 'a'.repeat(64), viz_unittests: 'b'.repeat(64) },
      results: { cc: { passed: true, count: 17, xmlSha256: 'c'.repeat(64) }, viz: { passed: true, count: 4, xmlSha256: 'd'.repeat(64) } } } };
  const path = join(root, 'chromium/virtual-desktop-build-state.json');
  await writeFile(path, JSON.stringify(state));
  assert.equal((await verifiedEngine(root, { requireStream: true })).binary, join(root, directory, 'headless_shell'));
  await mkdir(join(root, LEAN_DIRECTORY), { recursive: true });
  for (const name of MONOLITHIC_REQUIRED)
    await writeFile(join(root, LEAN_DIRECTORY, name), 'synthetic monolithic fixture: ' + name);
  await writeFile(join(root, LEAN_DIRECTORY, 'args.gn'), profile);
  const testArtifacts = {};
  for (const name of ['cc_unittests', 'viz_unittests']) {
    await writeFile(join(root, LEAN_DIRECTORY, name), 'synthetic test executable: ' + name);
    testArtifacts[name] = await sha256(join(root, LEAN_DIRECTORY, name));
  }
  const raw = { ...state, distributionFormat: undefined, stage: 'lean-engine-tests-complete',
    binary: join(root, LEAN_DIRECTORY, 'headless_shell'), cppTestsEvidence: { ...state.cppTestsEvidence, testArtifacts } };
  await writeFile(join(root, 'chromium/virtual-desktop-lean-ninja-build-state.json'), JSON.stringify(raw));
  assert.equal((await verifiedEngine(root, { layout: 'lean' })).binary, raw.binary);
  await writeFile(join(root, LEAN_DIRECTORY, 'cc_unittests'), 'changed C++ test executable');
  await assert.rejects(verifiedEngine(root, { layout: 'lean' }), /C\+\+ test executable differs/);
  await writeFile(path, JSON.stringify({ ...state, cppTestsEvidence: { ...state.cppTestsEvidence, binarySha256: 'e'.repeat(64) } }));
  await assert.rejects(verifiedEngine(root), /C\+\+ evidence/);
  await writeFile(path, JSON.stringify({ ...state, cppTestsEvidence: undefined }));
  await assert.rejects(verifiedEngine(root), /C\+\+ evidence/);
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(verifyArtifacts({ ...state, distributionFormat: 'native-runtime-v1' }, root), /outside/);
  await writeFile(join(root, 'chromium/lean-profile.gn'), 'different configuration');
  await assert.rejects(verifiedEngine(root), /profile fingerprint/);
  await writeFile(join(root, 'chromium/lean-profile.gn'), profile);
  await writeFile(join(root, directory, 'icudtl.dat'), 'changed runtime data');
  await assert.rejects(verifiedEngine(root), /checksum differs/);
});
