import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifiedEngine } from './verified.js';
import { sha256, artifactLayout, MONOLITHIC_FORMAT } from './artifacts.js';
import { loadReplayRuntime, verifyRuntimeBuild, validateFontCatalog } from '../chromium-paint/runtime.js';

const exec = promisify(execFile);
const ENGINE_DIRECTORY = 'chromium/src/out/VirtualDesktop';

export function auditMachOOutput(stdout, names, installIds = {}) {
  const available = new Set(names);
  const binaries = names.filter(name => name === 'headless_shell' || name.endsWith('.dylib'));
  const internal = new Set(), system = new Set(), seenIdentity = new Set();
  let current;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('\t') && line.endsWith(':')) { current = basename(line.slice(0, -1)); continue; }
    if (!line.startsWith('\t')) continue;
    const address = line.trim().split(' (compatibility version ')[0];
    // otool -L also prints LC_ID_DYLIB. A library's own identity is not a
    // load dependency; relative identities must never whitelist other loads.
    if (installIds[current] === address && !seenIdentity.has(current)) {
      if (!['./', '@rpath/', '@loader_path/', '@executable_path/'].some(prefix => address === prefix + current))
        throw new Error('External Mach-O install identity: ' + address);
      seenIdentity.add(current); continue;
    }
    if (address.startsWith('/System/Library/') || address.startsWith('/usr/lib/')) { system.add(address); continue; }
    const match = /^@(rpath|loader_path|executable_path)\/([A-Za-z0-9_.+-]+)$/.exec(address);
    if (!match || !available.has(match[2])) throw new Error('Unresolved or external non-system Mach-O dependency: ' + address);
    internal.add(match[2]);
  }
  return { checkedBinaries: binaries.length, internalLibraries: internal.size, systemLibraries: system.size,
    scope: 'All declared Mach-O load commands resolve within the package or macOS system paths. Dynamic plugin/data lookup still needs runtime tests.' };
}

export async function auditMachOLinks(directory, names) {
  const binaries = names.filter(name => name === 'headless_shell' || name.endsWith('.dylib'));
  const libraries = binaries.filter(name => name.endsWith('.dylib'));
  const [loads, identities] = await Promise.all([
    exec('/usr/bin/otool', ['-L', ...binaries.map(name => join(directory, name))], { timeout: 60000, maxBuffer: 32 * 1024 ** 2 }),
    libraries.length ? exec('/usr/bin/otool', ['-D', ...libraries.map(name => join(directory, name))], { timeout: 60000, maxBuffer: 4 * 1024 ** 2 }) : Promise.resolve({ stdout: '' }),
  ]);
  const installIds = {}; let current;
  for (const line of identities.stdout.split('\n')) {
    if (line.endsWith(':')) current = basename(line.slice(0, -1));
    else if (line.trim() && current) { installIds[current] = line.trim(); current = null; }
  }
  return auditMachOOutput(loads.stdout, names, installIds);
}

// GN's data closure includes generated DevTools UI and Python build helpers.
// This package serves CDP and native records, without the DevTools frontend.
export function selectRuntimeFiles(dependencies) {
  if (!Array.isArray(dependencies) || !dependencies.length) throw new Error('Missing GN runtime dependencies');
  const included = new Set(), excluded = [];
  for (const entry of dependencies) {
    if (typeof entry !== 'string') throw new Error('Invalid runtime dependency');
    const name = entry.startsWith('./') ? entry.slice(2) : entry;
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe runtime dependency: ' + entry);
    }
    if (/^(gen\/third_party\/devtools-frontend\/|pyproto\/|angledata\/)/.test(name)) { excluded.push(name); continue; }
    if (!/^[A-Za-z0-9_.+-]+$/.test(name) ||
        !(name === 'headless_shell' || /\.(dylib|pak|dat|bin)$/.test(name) || name === 'vk_swiftshader_icd.json')) {
      throw new Error('Unreviewed runtime dependency: ' + name);
    }
    included.add(name);
  }
  if (!included.has('headless_shell') || !included.has('icudtl.dat')) throw new Error('Incomplete pinned runtime dependency closure');
  return { included: [...included].sort(), excluded: [...new Set(excluded)].sort() };
}

export async function packageRuntime({ root, canvasKitDirectory, output, layout = 'component', fontAssetsDirectory }) {
  root = resolve(root); canvasKitDirectory = resolve(canvasKitDirectory); output = resolve(output);
  const engine = await verifiedEngine(root, { requireStream: true, layout });
  if (engine.state.distributionFormat) throw new Error('Package from the tested build, not an existing distribution');
  const runtime = await loadReplayRuntime(canvasKitDirectory);
  await verifyRuntimeBuild(runtime, canvasKitDirectory, root, engine.source);
  if (runtime.metadata.skiaRevision !== engine.source.skiaRevision) throw new Error('CanvasKit/Chromium Skia revisions differ');
  const outputRelative = relative(root, output);
  if (outputRelative !== '..' && !outputRelative.startsWith('../')) throw new Error('Output must be outside the build root');
  try { await lstat(output); throw new Error('Output already exists; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const buildDirectory = artifactLayout(engine.state, root).directory;
  const monolithic = engine.state.engineLayout === 'monolithic';
  const format = monolithic ? MONOLITHIC_FORMAT : 'native-runtime-v1';
  const gnOutput = monolithic ? 'out/VirtualDesktopLeanNinja' : 'out/VirtualDesktop';
  const { stdout } = await exec(join(root, 'depot_tools/gn'), ['desc', gnOutput, '//headless:headless_shell', 'runtime_deps', '--format=json'],
    { cwd: join(root, 'chromium/src'), timeout: 60000, maxBuffer: 8 * 1024 ** 2, env: { ...process.env, DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_METRICS: '0',
      ...(monolithic ? { VIRTUAL_DESKTOP_LEAN_ROOT: 'headless' } : {}) } });
  const dependencies = JSON.parse(stdout)['//headless:headless_shell']?.runtime_deps;
  const selection = selectRuntimeFiles(dependencies);
  const nativeDependencyAudit = await auditMachOLinks(buildDirectory, selection.included);
  await mkdir(dirname(output), { recursive: true });
  const staging = join(dirname(output), '.' + basename(output) + '-' + randomUUID());
  await mkdir(staging);
  const files = {};
  async function copy(source, target, expected) {
    if (!(await lstat(source)).isFile()) throw new Error('Runtime source must be a regular file: ' + source);
    const destination = join(staging, target); await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const hash = await sha256(destination);
    if (expected && expected !== hash) throw new Error('Runtime source changed while packaging: ' + target);
    files[target] = { bytes: (await stat(destination)).size, sha256: hash };
    return hash;
  }
  try {
    let fonts = runtime.metadata.fonts || [], fontSource = canvasKitDirectory;
    if (fontAssetsDirectory) {
      fontSource = resolve(fontAssetsDirectory);
      const catalog = JSON.parse(await readFile(join(fontSource, 'fonts/catalog.json'), 'utf8'));
      if (catalog.version !== 1) throw new Error('Unsupported runtime font catalog');
      fonts = validateFontCatalog(catalog.fonts);
    }
    for (const font of fonts) await copy(join(fontSource, font.path), 'canvaskit/out/' + font.path, font.id);
    const artifacts = {};
    for (const name of selection.included) {
      if (name !== 'vk_swiftshader_icd.json' && !engine.state.artifacts[name]) throw new Error('Unfingerprinted engine artifact: ' + name);
      artifacts[name] = await copy(join(buildDirectory, name), ENGINE_DIRECTORY + '/' + name, engine.state.artifacts[name]);
    }
    if (monolithic) await copy(join(buildDirectory, 'args.gn'), 'chromium/lean-profile.gn', engine.state.profileSha256);
    const buildState = { ...engine.state, distributionFormat: format, stage: 'engine-tests-complete', binary: ENGINE_DIRECTORY + '/headless_shell', artifacts,
      packaging: { originalArtifactsSha256: engine.artifactsSha256, scope: 'Exact C++-tested ' + (monolithic ? 'monolithic' : 'component') + ' bytes; no implied native/visual or RSS acceptance.' } };
    delete buildState.log; delete buildState.pid;
    await writeFile(join(staging, 'chromium/virtual-desktop-build-state.json'), JSON.stringify(buildState, null, 2) + '\n');
    for (const name of ['canvaskit.js', 'canvaskit.wasm', 'runtime.json', 'args.gn']) {
      await copy(join(canvasKitDirectory, name), 'canvaskit/out/' + name, runtime.metadata.assets[name]);
    }
    if (fonts.length) {
      const metadataPath = 'canvaskit/out/runtime.json';
      await writeFile(join(staging, metadataPath), JSON.stringify({ ...runtime.metadata, fonts }, null, 2) + '\n');
      files[metadataPath] = { bytes: (await stat(join(staging, metadataPath))).size, sha256: await sha256(join(staging, metadataPath)) };
    }
    const canvasState = JSON.parse(await readFile(join(root, 'canvaskit/build-state.json'), 'utf8'));
    await writeFile(join(staging, 'canvaskit/build-state.json'), JSON.stringify({ ...canvasState,
      distributionFormat: 'native-runtime-v1', output: 'canvaskit/out' }, null, 2) + '\n');
    await copy(join(root, 'chromium/src/LICENSE'), 'LICENSE.chromium');
    const totalBytes = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
    let excludedBytes = 0;
    for (const name of selection.excluded) excludedBytes += (await stat(join(buildDirectory, name))).size;
    const manifest = { version: 1, kind: format, createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
      chromiumVersion: engine.source.version, revision: engine.source.revision, patchSha256: engine.patchSha256,
      engineSplitGate: 'not-passed', serverRasterBypassed: false, files, totalBytes, nativeDependencyAudit,
      selection: { method: 'Pinned GN runtime closure; omit generated DevTools frontend, Python helpers and ANGLE validation metadata',
        originalDependencyFiles: new Set(dependencies).size, engineFiles: selection.included.length, excludedFiles: selection.excluded.length, excludedBytes },
      fontAssets: { count: fonts.length, bytes: fonts.reduce((sum, font) => sum + font.bytes, 0),
        scope: 'Explicitly provisioned common fonts are immutable binary runtime assets. Other website fonts use the authorized session binary endpoint.' },
      scope: 'Local CDP/native-records runtime. OS frameworks, producer system fonts, Node.js and this app are external. No source, compiler, test executables or build logs. No claim of minimal Chromium features, lower RSS, general web or video compatibility.' };
    await writeFile(join(staging, 'runtime-package.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Verify from the new root before publishing the directory. Relative state
    // paths also permit moving this package without editing build provenance.
    await verifiedEngine(staging, { requireStream: true });
    const packagedRuntime = await loadReplayRuntime(join(staging, 'canvaskit/out'));
    try { await verifyRuntimeBuild(packagedRuntime, join(staging, 'canvaskit/out'), staging, engine.source); }
    finally { packagedRuntime.close?.(); }
    await rename(staging, output);
    return { output, totalBytes, files: Object.keys(files).length, engineFiles: selection.included.length,
      excludedBytes, excludedFiles: selection.excluded.length, engineSplitGate: 'not-passed' };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  finally { runtime.close?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
    canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, output: { type: 'string' }, layout: { type: 'string', default: 'component' },
    'font-assets': { type: 'string' } } });
  if (!values.root || !values.canvaskit || !values.output) throw new Error('Pass --root, --canvaskit and a new --output directory');
  console.log(JSON.stringify(await packageRuntime({ root: values.root, canvasKitDirectory: values.canvaskit, output: values.output, layout: values.layout,
    fontAssetsDirectory: values['font-assets'] }), null, 2));
}
