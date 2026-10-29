#!/usr/bin/env python3
"""Isolated size-oriented candidate build; never rewrites the tested engine state."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import build

HERE = Path(__file__).resolve().parent
OUT = 'out/VirtualDesktopLeanNinja'
GN_ROOT_BASE_SHA256 = '1c33e1726ea5b347730043bf1837fb17bedbeee4651ae9d8393f0d191fb0dd24'
V8_FLAGS_TARGET = '//v8:v8_base_without_compiler(//build/toolchain/mac:clang_arm64)'
V8_METAGEN_TARGET = 'gen/v8/metagen/instance-types.h'


def effective_args(text):
    return ''.join(line.split('#', 1)[0].strip() for line in text.splitlines())


def build_jobs(value):
    jobs = int(value)
    if not 1 <= jobs <= 8:
        raise ValueError('Build jobs must be between 1 and 8')
    return jobs


class LeanBuild:
    def __init__(self, root):
        self.root = root
        self.src = root / 'chromium/src'
        self.output = self.src / OUT
        self.state_path = root / 'chromium/virtual-desktop-lean-ninja-build-state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.env = build.environment(root)
        self.env['VIRTUAL_DESKTOP_LEAN_ROOT'] = 'headless'

    def save(self, **fields):
        self.state.update(fields, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.state['engineSplitGate'] = 'not-passed'
        temporary = self.state_path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self.state, indent=2) + '\n')
        temporary.replace(self.state_path)

    def validate(self):
        if build.capture(['git', 'rev-parse', 'HEAD'], self.src) != build.CONFIG['revision']:
            raise ValueError('Lean checkout differs from the pinned revision')
        for name, expected in build.CONFIG['files'].items():
            if build.digest(self.src / name) != expected['patchedSha256']:
                raise ValueError('Lean source changed: ' + name)
        root_patch = self.state.get('gnRootPatch')
        if root_patch and build.digest(self.src / '.gn') != root_patch['patchedSha256']:
            raise ValueError('Candidate GN root changed; preserving it')

    def prepare_gn_root(self):
        path = self.src / '.gn'
        suffix = (HERE / 'lean-root.gn').read_bytes()
        current = path.read_bytes()
        base = current[:-len(suffix)] if current.endswith(suffix) else current
        if hashlib.sha256(base).hexdigest() != GN_ROOT_BASE_SHA256:
            raise ValueError('Unrecognized .gn; preserving custom build configuration')
        patched = base + suffix
        if current != patched:
            temporary = path.with_name('.gn.virtual-desktop.tmp')
            temporary.write_bytes(patched)
            temporary.replace(path)
        self.save(gnRootPatch={'path': '.gn', 'baseSha256': GN_ROOT_BASE_SHA256,
                  'patchedSha256': build.digest(path), 'snippetSha256': build.digest(HERE / 'lean-root.gn'),
                  'environment': {'VIRTUAL_DESKTOP_LEAN_ROOT': 'headless'},
                  'scope': 'Candidate build graph only; inactive without its environment flag.'})

    def run(self, phase, command):
        path = self.root / 'logs' / ('chromium-lean-' + phase + '.log')
        with path.open('a') as log:
            log.write('\n=== ' + datetime.datetime.now(datetime.timezone.utc).isoformat() + ' ' + json.dumps([str(arg) for arg in command]) + ' ===\n')
            log.flush()
            child = subprocess.Popen([str(arg) for arg in command], cwd=self.src, env=self.env, stdout=log, stderr=subprocess.STDOUT)
            self.save(stage=phase + '-running', pid=child.pid, exitCode=None, log=str(path),
                      startedUnix=datetime.datetime.now().timestamp(), finishedUnix=None)
            print(json.dumps({'phase': phase, 'pid': child.pid, 'log': str(path)}), flush=True)
            code = child.wait()
        self.save(stage=phase + ('-complete' if code == 0 else '-failed'), pid=None, exitCode=code, finishedUnix=datetime.datetime.now().timestamp())
        if code:
            raise RuntimeError('Lean ' + phase + ' failed; inspect ' + str(path))

    def configure(self):
        self.validate()
        profile = (HERE / 'lean-mac-arm64.gn').read_text()
        self.output.mkdir(parents=True, exist_ok=True)
        args = self.output / 'args.gn'
        if args.exists() and effective_args(args.read_text()) != effective_args(profile):
            raise ValueError('Existing lean args.gn differs; preserving it')
        self.prepare_gn_root()
        args.write_text(profile)
        self.save(compiled=False, ccTestsPassed=False, vizTestsPassed=False, v8MetagenPassed=False, safetyStop=None, output=str(self.output),
                  builder='ninja', revision=build.CONFIG['revision'],
                  patchSha256=build.digest(HERE / build.CONFIG['patch']), profileSha256=build.digest(args))
        self.run('configure', [self.root / 'depot_tools/gn', 'gen', OUT,
                 '--root-target=//headless:headless_shell', '--root-pattern=//headless:headless_shell', '--fail-on-unused-args'])
        # Deliberately omit root switches: metagen's nested GN call does too.
        # This catches loss of the candidate environment before a long build.
        self.run('v8-gn-preflight', [self.src / 'buildtools/mac/gn', 'desc', '-q', OUT, V8_FLAGS_TARGET, '--format=json'])

    def compile(self, jobs=1):
        jobs = build_jobs(jobs)
        self.validate()
        if effective_args((self.output / 'args.gn').read_text()) != effective_args((HERE / 'lean-mac-arm64.gn').read_text()):
            raise ValueError('Lean configuration changed before compilation')
        self.save(compiled=False, ccTestsPassed=False, vizTestsPassed=False, jobs=jobs)
        self.run('v8-metagen-preflight', [self.root / 'depot_tools/autoninja', '-C', OUT,
                 V8_METAGEN_TARGET, '-j', str(jobs)])
        header = self.output / V8_METAGEN_TARGET
        if not header.is_file() or not header.stat().st_size:
            raise RuntimeError('V8 metagen returned without its generated header')
        self.save(v8MetagenPassed=True, v8MetagenHeaderSha256=build.digest(header))
        # The coordinator bounds local concurrency and its independent watchdog
        # enforces RSS, host pressure, swapping and parent heartbeat.
        self.run('build', [self.root / 'depot_tools/autoninja', '-C', OUT, 'headless_shell', '-j', str(jobs)])
        self.validate()
        binary = self.output / 'headless_shell'
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError('Lean build returned without an executable')
        artifacts = {path.name: build.digest(path) for path in sorted(self.output.iterdir())
                     if path.is_file() and (path.suffix in ['.dylib', '.pak', '.dat', '.bin'] or path.name == 'headless_shell')}
        self.save(compiled=True, stage='lean-compiled-candidate', binary=str(binary), binarySha256=artifacts['headless_shell'], artifacts=artifacts,
                  scope='Compilation candidate only; no C++/native/visual acceptance and no live engine replacement.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['configure', 'build', 'status'])
    parser.add_argument('--root', default=os.environ.get('CHROMIUM_BUILD_ROOT'))
    parser.add_argument('--jobs', type=build_jobs, default=1)
    values = parser.parse_args()
    root = build.build_root(values.root)
    preflight = build.preflight(root, 80 if values.phase == 'build' else 0)
    runner = LeanBuild(root)
    if values.phase == 'status':
        print(json.dumps({'preflight': preflight, 'state': runner.state}, indent=2)); return
    for directory in ['logs', 'tmp', 'cache']:
        (root / directory).mkdir(exist_ok=True)
    with (root / '.virtual-desktop-build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in [root / 'chromium/virtual-desktop-build-state.json',
                     root / 'chromium/virtual-desktop-lean-build-state.json', runner.state_path]:
            if path.exists():
                pid = json.loads(path.read_text()).get('pid')
                if pid:
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(pid, 0)
                        raise RuntimeError('A recorded build process is still alive; inspect before resuming')
        runner.save(volumeUUID=preflight['volumeUUID'])
        runner.configure()
        if values.phase == 'build':
            runner.compile(values.jobs)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('Lean build: ' + str(error), file=sys.stderr); sys.exit(1)
