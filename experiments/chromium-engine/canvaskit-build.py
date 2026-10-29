#!/usr/bin/env python3
"""Build pinned Chromium Skia as a local CanvasKit with explicit A8/CFF coverage."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from build import capture, digest, environment, preflight, build_root

HERE = Path(__file__).resolve().parent
SOURCE = json.loads((HERE / 'canvaskit-source.json').read_text())

SKIA_REVISION = SOURCE['skiaRevision']
EMSDK_VERSION = '4.0.7'  # Pinned Skia bin/activate-emsdk.
DEPENDENCIES = ['emsdk', 'freetype', 'libjpeg-turbo', 'libpng', 'libwebp', 'wuffs', 'zlib']
GN_ARGS = '''is_debug = false
is_official_build = true
is_component_build = false
is_trivial_abi = true
is_canvaskit = true
target_cpu = "wasm"
werror = true
skia_enable_ganesh = false
skia_enable_graphite = false
skia_enable_pdf = false
skia_enable_skottie = false
skia_enable_skparagraph = false
skia_enable_skshaper = false
skia_use_angle = false
skia_use_dawn = false
skia_use_dng_sdk = false
skia_use_expat = false
skia_use_fontconfig = false
skia_use_freetype = true
skia_use_freetype_woff2 = false
skia_use_system_freetype2 = false
skia_use_harfbuzz = false
skia_use_icu = false
skia_use_libjpeg_turbo_decode = true
skia_use_libjpeg_turbo_encode = true
skia_use_libpng_decode = true
skia_use_libpng_encode = true
skia_use_libwebp_decode = true
skia_use_libwebp_encode = true
skia_use_partition_alloc = false
skia_use_system_libjpeg_turbo = false
skia_use_system_libpng = false
skia_use_system_libwebp = false
skia_use_system_zlib = false
skia_use_vulkan = false
skia_use_webgl = false
skia_use_webgpu = false
skia_use_wuffs = true
skia_use_zlib = true
skia_enable_fontmgr_custom_directory = false
skia_enable_fontmgr_custom_embedded = true
skia_enable_fontmgr_custom_empty = true
skia_canvaskit_enable_skp_serialization = true
skia_canvaskit_enable_effects_deserialization = true
skia_canvaskit_enable_canvas_bindings = false
skia_canvaskit_enable_font = true
skia_canvaskit_enable_embedded_font = false
skia_canvaskit_enable_paragraph = false
skia_canvaskit_enable_webgl = false
skia_canvaskit_enable_webgpu = false
skia_canvaskit_profile_build = true
extra_cflags = [ "-DSK_GAMMA_APPLY_TO_A8", "-DSK_GAMMA_EXPONENT=1.0", "-DSK_GAMMA_CONTRAST=0.0" ]
'''


class CanvasKitBuild:
    def __init__(self, root):
        self.root = root
        self.source = root / 'chromium/src/third_party/skia'
        self.work = root / 'canvaskit'
        self.output = self.work / 'out'
        self.state_path = self.work / 'build-state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.env = environment(root)
        self.env['EM_CACHE'] = str(self.work / 'emscripten-cache')
        self.env['EM_CONFIG'] = str(self.source / 'third_party/externals/emsdk/.emscripten')

    def save(self, **fields):
        self.state.update(fields, skiaRevision=SKIA_REVISION, emsdkVersion=EMSDK_VERSION,
                          output=str(self.output), updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        temporary = self.state_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, indent=2) + '\n')
        temporary.replace(self.state_path)

    def run(self, phase, args, cwd=None):
        log_path = self.root / 'logs' / ('canvaskit-' + phase + '.log')
        with log_path.open('a') as log:
            log.write('\n=== ' + datetime.datetime.now(datetime.timezone.utc).isoformat() +
                      ' ' + json.dumps([str(x) for x in args]) + ' ===\n')
            log.flush()
            process = subprocess.Popen([str(x) for x in args], cwd=cwd or self.source,
                                       env=self.env, stdout=log, stderr=subprocess.STDOUT)
            self.save(stage=phase + '-running', pid=process.pid, exitCode=None, log=str(log_path))
            print(json.dumps({'stage': phase, 'pid': process.pid, 'log': str(log_path)}), flush=True)
            code = process.wait()
        self.save(stage=phase + ('-complete' if code == 0 else '-failed'), pid=None, exitCode=code)
        if code:
            raise RuntimeError('CanvasKit %s failed; inspect %s' % (phase, log_path))

    def sync(self):
        # Read exact pins as data; never execute the downloaded DEPS file.
        deps = dict(re.findall(r'[\'"](third_party/externals/[^\'"]+)[\'"]\s*:\s*[\'"]([^\'"]+)[\'"]',
                               (self.source / 'DEPS').read_text()))
        for name in DEPENDENCIES:
            relative = 'third_party/externals/' + name
            url, revision = deps[relative].rsplit('@', 1)
            if not re.fullmatch(r'[0-9a-f]{40}', revision) or not url.startswith('https://'):
                raise ValueError('Unpinned dependency: ' + name)
            path = self.source / relative
            if not path.exists():
                path.mkdir(parents=True)
                self.run('dep-init-' + name, ['git', 'init', path])
                self.run('dep-origin-' + name, ['git', 'remote', 'add', 'origin', url], path)
            if capture(['git', 'rev-parse', '--show-toplevel'], path) != str(path):
                raise ValueError('Dependency is not its own checkout: ' + str(path))
            if capture(['git', 'remote', 'get-url', 'origin'], path) != url:
                raise ValueError('Dependency remote changed: ' + name)
            head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=path, capture_output=True, text=True)
            if head.returncode == 0 and head.stdout.strip() != revision:
                raise ValueError('Existing dependency revision differs: ' + name)
            if head.returncode:
                self.run('dep-fetch-' + name, ['git', 'fetch', '--depth', '1', 'origin', revision], path)
                self.run('dep-checkout-' + name, ['git', 'checkout', '--detach', revision], path)
            if capture(['git', 'status', '--porcelain', '--untracked-files=no'], path):
                raise ValueError('Dependency contains tracked changes: ' + name)
        if not (self.source / 'bin/gn').exists():
            self.run('fetch-gn', [sys.executable, 'bin/fetch-gn'])
        sdk = self.source / 'third_party/externals/emsdk'
        # Do not use --permanent or modify the user's shell configuration.
        self.run('sdk-install', [sys.executable, sdk / 'emsdk.py', 'install', EMSDK_VERSION])
        self.run('sdk-activate', [sys.executable, sdk / 'emsdk.py', 'activate', EMSDK_VERSION])
        self.save(stage='sync-complete')

    def configure(self):
        self.apply()
        self.output.mkdir(parents=True, exist_ok=True)
        args = self.output / 'args.gn'
        if args.exists() and args.read_text() != GN_ARGS:
            raise ValueError('Existing CanvasKit GN arguments differ; refusing to overwrite')
        args.write_text(GN_ARGS)
        self.save(compiled=False)
        self.run('configure', [self.source / 'bin/gn', 'gen', self.output])

    def apply(self):
        changes = SOURCE['files']
        hashes = {name: digest(self.source / name) for name in changes}
        if all(hashes[name] == values['patchedSha256'] for name, values in changes.items()):
            return
        if not all(hashes[name] == values['upstreamSha256'] for name, values in changes.items()):
            raise ValueError('CanvasKit patch inputs changed; refusing to overwrite')
        patch = HERE / SOURCE['patch']
        self.run('patch-check', ['git', 'apply', '--check', patch])
        self.run('patch', ['git', 'apply', patch])
        for name, values in changes.items():
            if digest(self.source / name) != values['patchedSha256']:
                raise ValueError('CanvasKit patched source checksum differs: ' + name)

    def compile(self, jobs):
        if (self.output / 'args.gn').read_text() != GN_ARGS:
            raise ValueError('Configure the pinned CanvasKit profile before building')
        for name, values in SOURCE['files'].items():
            if digest(self.source / name) != values['patchedSha256']:
                raise ValueError('CanvasKit source differs: ' + name)
        self.save(compiled=False)
        self.run('build', [self.root / 'chromium/src/third_party/ninja/ninja',
                           '-C', self.output, '-j', str(jobs), 'canvaskit.js'])
        assets = {name: digest(self.output / name) for name in ['canvaskit.js', 'canvaskit.wasm']}
        metadata = {'schemaVersion': 1, 'id': 'chromium-skia-' + SKIA_REVISION[:12] + '-mac-unhinted-cff-fonts-v1',
                    'skiaRevision': SKIA_REVISION, 'emsdkVersion': EMSDK_VERSION,
                    'profilingFunctions': True, 'gnArgsSha256': digest(self.output / 'args.gn'),
                    'backend': 'software', 'text': {'gammaAppliesToA8': True, 'gamma': 1, 'contrast': 0,
                                                  'cffStemDarkening': True, 'darkeningCurve': 'FreeType default'},
                    'patchSha256': digest(HERE / SOURCE['patch']),
                    'fontRegistry': SOURCE['fontRegistry'],
                    'assets': assets, 'scope': 'Experimental CPU SKP replay; no WebGL or paragraph shaping'}
        (self.output / 'runtime.json').write_text(json.dumps(metadata, indent=2) + '\n')
        self.save(compiled=True, assets=assets)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['sync', 'apply', 'configure', 'build'])
    parser.add_argument('--root', default=os.environ.get('CHROMIUM_BUILD_ROOT'))
    parser.add_argument('--jobs', type=int, default=4)
    args = parser.parse_args()
    root = build_root(args.root)
    if not 1 <= args.jobs <= 4:
        raise ValueError('Use 1–4 local build jobs')
    preflight(root, 10)
    build = CanvasKitBuild(root)
    if capture(['git', 'rev-parse', 'HEAD'], build.source) != SKIA_REVISION:
        raise ValueError('Skia differs from the pinned Chromium dependency')
    build.work.mkdir(exist_ok=True)
    (root / 'logs').mkdir(exist_ok=True)
    with (build.work / '.build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pid = build.state.get('pid')
        if pid:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError('Recorded CanvasKit process still exists')
        {'sync': build.sync, 'apply': build.apply, 'configure': build.configure,
         'build': lambda: build.compile(args.jobs)}[args.phase]()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
