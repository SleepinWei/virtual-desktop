#!/usr/bin/env python3
"""Pinned, resumable macOS Chromium builds on an external APFS volume."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'source.json').read_text())
OUT = 'out/VirtualDesktop'
GN_ARGS = '''target_cpu = "arm64"
is_debug = false
is_component_build = true
symbol_level = 0
dcheck_always_on = true
use_remoteexec = false
chrome_pgo_phase = 0
'''


def capture(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def build_root(value):
    if not value:
        raise ValueError('Pass --root /Volumes/<APFS-volume>/Builds or CHROMIUM_BUILD_ROOT')
    path = Path(value).expanduser()
    if not path.is_absolute() or any(c.isspace() for c in str(path)):
        raise ValueError('Chromium requires an absolute build root without whitespace')
    return path.resolve()


def gclient_config():
    return ('solutions = [{"name": "src", "url": "' + CONFIG['repository'] +
            '", "managed": False, "custom_deps": {}, "custom_vars": '
            '{"checkout_pgo_profiles": False}}]\ntarget_os = ["mac"]\n')


def environment(root):
    return dict(os.environ,
                PATH=str(root / 'depot_tools') + os.pathsep + os.environ['PATH'],
                DEPOT_TOOLS_UPDATE='0', DEPOT_TOOLS_METRICS='0',
                GIT_TERMINAL_PROMPT='0',
                VPYTHON_VIRTUALENV_ROOT=str(root / 'cache/vpython'),
                CIPD_CACHE_DIR=str(root / 'cache/cipd'),
                TMPDIR=str(root / 'tmp') + '/',
                XDG_CACHE_HOME=str(root / 'cache'))


def preflight(root, minimum_gib=0):
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise ValueError('This build profile is for native macOS arm64')
    # Inspect an existing ancestor before mkdir: a disconnected disk must not
    # accidentally create a similarly named directory on the internal drive.
    ancestor = root
    while not ancestor.exists():
        ancestor = ancestor.parent
    mount = ancestor
    while not os.path.ismount(mount):
        mount = mount.parent
    info = plistlib.loads(subprocess.check_output(
        ['diskutil', 'info', '-plist', str(mount)]))
    if info.get('FilesystemType') != 'apfs' or info.get('Internal', True):
        raise ValueError('Build root must be on a mounted external APFS volume')
    if not info.get('WritableVolume'):
        raise ValueError('APFS volume is not writable')
    free = shutil.disk_usage(ancestor).free
    if free < minimum_gib * 1024**3:
        raise ValueError('Need at least %s GiB free; found %.1f GiB' %
                         (minimum_gib, free / 1024**3))
    for tool in ['git', 'python3', 'xcrun']:
        if not shutil.which(tool):
            raise ValueError('Missing build dependency: ' + tool)
    sdk = capture(['xcrun', '--show-sdk-path'])
    state_path = root / 'chromium/virtual-desktop-build-state.json'
    if state_path.exists():
        expected = json.loads(state_path.read_text()).get('volumeUUID')
        if expected and expected != info.get('VolumeUUID'):
            raise ValueError('External volume UUID differs from the recorded build')
    return {'root': str(root), 'volumeUUID': info['VolumeUUID'],
            'freeGiB': round(free / 1024**3, 2), 'sdk': sdk,
            'revision': CONFIG['revision'], 'target': 'headless_shell',
            'engineSplitGate': 'not-passed'}


class Build:
    def __init__(self, root):
        self.root = root
        self.checkout = root / 'chromium'
        self.src = self.checkout / 'src'
        self.env = environment(root)
        self.state_path = self.checkout / 'virtual-desktop-build-state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def save(self, **fields):
        self.state.update(fields, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.state['engineSplitGate'] = 'not-passed'
        temporary = self.state_path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self.state, indent=2) + '\n')
        temporary.replace(self.state_path)

    def run(self, name, args, cwd=None):
        log_path = self.root / 'logs' / ('chromium-' + name + '.log')
        with log_path.open('a') as log:
            log.write('\n=== ' + datetime.datetime.now(datetime.timezone.utc).isoformat() +
                      ' ' + json.dumps([str(a) for a in args]) + ' ===\n')
            log.flush()
            print(json.dumps({'phase': name, 'command': [str(a) for a in args],
                              'log': str(log_path)}), flush=True)
            process = subprocess.Popen([str(a) for a in args], cwd=cwd or self.src,
                                       env=self.env, stdout=log, stderr=subprocess.STDOUT)
            self.save(stage=name + '-running', pid=process.pid, log=str(log_path),
                      exitCode=None, startedUnix=datetime.datetime.now().timestamp(), finishedUnix=None)
            try:
                code = process.wait()
            except KeyboardInterrupt:
                # The child receives terminal SIGINT too. Preserve partial
                # checkouts/builds and their logs for a later resume.
                self.save(stage=name + '-interrupted')
                raise
        self.save(stage=name + ('-complete' if code == 0 else '-failed'),
                  pid=None, exitCode=code, finishedUnix=datetime.datetime.now().timestamp())
        if code:
            raise RuntimeError('%s failed (%s); inspect %s' % (name, code, log_path))

    def head(self):
        actual = capture(['git', 'rev-parse', 'HEAD'], self.src)
        if actual != CONFIG['revision']:
            raise ValueError('Checkout differs from the pinned Chromium revision: ' + actual)

    def sync(self):
        depot = self.root / 'depot_tools'
        if not depot.exists():
            self.run('depot-clone', ['git', 'clone', CONFIG['depotToolsRepository'], depot], self.root)
            self.run('depot-pin', ['git', 'checkout', '--detach', CONFIG['depotToolsRevision']], depot)
        if capture(['git', 'rev-parse', 'HEAD'], depot) != CONFIG['depotToolsRevision']:
            raise ValueError('depot_tools differs from the pinned revision; no automatic reset')
        self.bootstrap()
        config_path = self.checkout / '.gclient'
        if config_path.exists() and config_path.read_text() != gclient_config():
            raise ValueError('Existing .gclient differs; refusing to overwrite')
        if self.src.exists() and (self.src / '.git').exists():
            dirty = capture(['git', 'status', '--porcelain'], self.src)
            if dirty:
                raise ValueError('Source has local changes; preserve them before syncing')
        config_path.write_text(gclient_config())
        self.save(compiled=False, ccTestsPassed=False)
        self.run('sync', [depot / 'gclient', 'sync', '--no-history', '--nohooks',
                         '--revision', 'src@' + CONFIG['revision'], '--jobs', '4'], self.checkout)
        self.head()

    def hooks(self):
        self.head()
        self.run('hooks', [self.root / 'depot_tools/gclient', 'runhooks'], self.checkout)

    def bootstrap(self):
        # gclient's vpython runtime alone does not initialize the Python shim
        # still used by gn/autoninja in this pinned depot_tools version.
        self.run('bootstrap', [self.root / 'depot_tools/ensure_bootstrap'], self.root)

    def apply(self):
        self.head()
        patch = HERE / CONFIG['patch']
        changes = CONFIG['files']
        if not changes:
            raise ValueError('Patch manifest has no reviewed source files')
        hashes = {name: digest(self.src / name) for name in changes}
        if all(hashes[name] == values['patchedSha256'] for name, values in changes.items()):
            if self.state.get('patchSha256') != digest(patch):
                self.save(compiled=False, ccTestsPassed=False, vizTestsPassed=False)
            self.save(stage='patch-complete', patchSha256=digest(patch))
            return
        if not all(hashes[name] == values['upstreamSha256'] for name, values in changes.items()):
            raise ValueError('Patch inputs have changed; refusing to overwrite engine work')
        self.save(compiled=False, ccTestsPassed=False, vizTestsPassed=False)
        self.run('patch-check', ['git', 'apply', '--check', str(patch)])
        self.run('patch', ['git', 'apply', str(patch)])
        for name, values in changes.items():
            if digest(self.src / name) != values['patchedSha256']:
                raise RuntimeError('Patched source checksum mismatch: ' + name)
        self.save(stage='patch-complete', patchSha256=digest(patch))

    def configure(self):
        self.head()
        output = self.src / OUT
        output.mkdir(parents=True, exist_ok=True)
        args = output / 'args.gn'
        if args.exists() and args.read_text() != GN_ARGS:
            raise ValueError('Existing args.gn differs; refusing to replace build configuration')
        args.write_text(GN_ARGS)
        self.run('configure', [self.root / 'depot_tools/gn', 'gen', OUT])

    def compile(self, jobs):
        self.head()
        for name, values in CONFIG['files'].items():
            if digest(self.src / name) != values['patchedSha256']:
                raise ValueError('Apply the pinned engine patch before building: ' + name)
        self.save(compiled=False, ccTestsPassed=False, vizTestsPassed=False)
        self.run('build', [self.root / 'depot_tools/autoninja', '-C', OUT,
                           'headless_shell', 'cc_unittests', 'viz_unittests', '-j', str(jobs)])
        for name, values in CONFIG['files'].items():
            if digest(self.src / name) != values['patchedSha256']:
                raise ValueError('Engine source changed during compilation: ' + name)
        binary = self.src / OUT / 'headless_shell'
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError('Build returned success without an executable headless_shell')
        artifacts = {p.name: digest(p) for p in sorted((self.src / OUT).iterdir())
                     if p.is_file() and (p.suffix in ['.dylib', '.pak', '.dat', '.bin'] or
                                         p.name in ['headless_shell', 'cc_unittests', 'viz_unittests'])}
        for required in ['headless_shell', 'libcc.dylib', 'libcc_base.dylib', 'libcc_paint.dylib', 'libblink_platform.dylib', 'libcomponents_viz_service.dylib']:
            if required not in artifacts:
                raise RuntimeError('Component build output missing: ' + required)
        self.save(binary=str(binary), binarySha256=artifacts['headless_shell'],
                  artifacts=artifacts, compiled=True, patchSha256=digest(HERE / CONFIG['patch']))

    def objects(self, jobs):
        self.head()
        for name, values in CONFIG['files'].items():
            if digest(self.src / name) != values['patchedSha256']:
                raise ValueError('Engine source differs from patch: ' + name)
        self.save(compiledObjectsPassed=False)
        targets = ['obj/cc/base/base/features.o',
                   'obj/cc/paint/paint/display_item_list.o',
                   'obj/cc/cc/picture_layer_impl.o',
                   'obj/cc/cc_unittests/picture_layer_impl_unittest.o',
                   'obj/components/viz/service/service/display.o',
                   'obj/components/viz/service/service/output_surface_provider_impl.o',
                   'obj/components/viz/service/service/output_surface_unified.o',
                   'obj/components/viz/service/unit_tests/display_unittest.o',
                   'obj/third_party/blink/renderer/platform/platform/layer_tree_settings.o']
        self.run('objects', [self.root / 'depot_tools/autoninja', '-C', OUT,
                             '-j', str(jobs)] + targets)
        self.save(compiledObjectsPassed=True)

    def test(self):
        self.head()
        self.run('cc-tests', [self.src / OUT / 'cc_unittests',
                 '--gtest_filter=RemotePaintPictureLayerImplTest.*:'
                 'LegacySWPictureLayerImplTest.UpdateTilesCreatesTilings',
                 '--test-launcher-jobs=1'])
        self.save(ccTestsPassed=True)
        self.run('viz-tests', [self.src / OUT / 'viz_unittests',
                 '--gtest_filter=DisplayTest.RemotePaint*:DisplayTest.DisplayDamaged',
                 '--test-launcher-jobs=1'])
        self.save(vizTestsPassed=True, stage='engine-tests-complete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['status', 'preflight', 'sync', 'bootstrap', 'hooks', 'apply',
                                          'configure', 'objects', 'build', 'test'])
    parser.add_argument('--root', default=os.environ.get('CHROMIUM_BUILD_ROOT'))
    parser.add_argument('--jobs', type=int, default=2)
    args = parser.parse_args()
    root = build_root(args.root)
    if not 1 <= args.jobs <= 4:
        raise ValueError('This 16 GiB profile accepts 1–4 local compilation jobs')
    report = preflight(root, 250 if args.phase == 'sync' else 80 if args.phase in ['objects', 'build'] else 0)
    if args.phase in ['status', 'preflight']:
        state_path = root / 'chromium/virtual-desktop-build-state.json'
        if state_path.exists():
            report['state'] = json.loads(state_path.read_text())
        print(json.dumps(report, indent=2))
        return
    for directory in ['chromium', 'cache', 'tmp', 'logs']:
        (root / directory).mkdir(parents=True, exist_ok=True)
    with (root / '.virtual-desktop-build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        build = Build(root)
        # A previously started job may predate this lock or outlive a stopped
        # wrapper. Never run a second writer against its checkout.
        pid = build.state.get('pid')
        if pid:
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, 0)
                raise RuntimeError('Recorded build process still exists; inspect status before resuming')
        build.save(volumeUUID=report['volumeUUID'], revision=CONFIG['revision'],
                   chromiumVersion=CONFIG['version'])
        phases = {'sync': build.sync, 'bootstrap': build.bootstrap, 'hooks': build.hooks, 'apply': build.apply,
                  'configure': build.configure, 'objects': lambda: build.objects(args.jobs),
                  'build': lambda: build.compile(args.jobs),
                  'test': build.test}
        phases[args.phase]()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('Chromium build: ' + str(error), file=sys.stderr)
        sys.exit(1)
