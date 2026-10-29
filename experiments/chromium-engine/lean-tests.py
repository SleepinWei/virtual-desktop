#!/usr/bin/env python3
"""Build and run pinned C++ tests with the existing lean candidate configuration."""
import argparse
import contextlib
import datetime
import fcntl
import importlib.util
import json
from pathlib import Path
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
import build

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('lean_build', HERE / 'lean-build.py')
lean = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lean)
TEST_ROOT = 'headless/virtual_desktop_lean_tests/BUILD.gn'
TEST_LABEL = '//headless/virtual_desktop_lean_tests:all'
CASES = {
    'cc': {'binary': 'cc_unittests', 'count': 19,
           'filter': 'RemotePaintPictureLayerImplTest.*:DisplayItemListTest.RemotePaint*:'
                     'PresentationTimeCallbackBufferTest.*:LegacySWPictureLayerImplTest.UpdateTilesCreatesTilings'},
    'viz': {'binary': 'viz_unittests', 'count': 4,
            'filter': 'DisplayTest.RemotePaint*:DisplayTest.DisplayDamaged'},
}


def checked_xml(path, expected_count):
    root = ET.parse(path).getroot()
    cases = root.findall('.//testcase')
    if len(cases) != expected_count or any(
            case.find('failure') is not None or case.find('error') is not None or
            case.find('skipped') is not None or case.get('status') != 'run' or
            case.get('result', 'completed') != 'completed' for case in cases):
        raise ValueError('C++ XML did not run and pass all %s required tests' % expected_count)
    return {'passed': True, 'count': len(cases), 'xmlSha256': build.digest(path),
            'names': [case.get('classname') + '.' + case.get('name') for case in cases]}


class LeanTests:
    def __init__(self, root):
        self.root = root
        self.candidate = lean.LeanBuild(root)
        self.src, self.output, self.env = self.candidate.src, self.candidate.output, self.candidate.env
        self.state_path = root / 'chromium/virtual-desktop-lean-tests-state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def save(self, **fields):
        self.state.update(fields, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        temporary = self.state_path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(self.state, indent=2) + '\n')
        temporary.replace(self.state_path)

    def validate(self):
        self.candidate.validate()
        state = self.candidate.state
        if not state.get('compiled') or state.get('exitCode') != 0:
            raise ValueError('Compile the lean candidate before building its C++ tests')
        if lean.effective_args((self.output / 'args.gn').read_text()) != lean.effective_args((HERE / 'lean-mac-arm64.gn').read_text()):
            raise ValueError('Lean test configuration differs from the candidate')
        if state.get('profileSha256') != build.digest(self.output / 'args.gn'):
            raise ValueError('Candidate configuration fingerprint changed')
        if state.get('binary') != str(self.output / 'headless_shell') or state.get('binarySha256') != build.digest(self.output / 'headless_shell'):
            raise ValueError('Candidate executable changed')
        for name, expected in state['artifacts'].items():
            if build.digest(self.output / name) != expected:
                raise ValueError('Candidate artifact changed: ' + name)

    def prepare_root(self):
        source = (HERE / 'lean-tests-root.gn').read_bytes()
        path = self.src / TEST_ROOT
        if path.exists() and path.read_bytes() != source:
            raise ValueError('Preserving custom C++ test root')
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(source)
        self.save(testRoot={'path': TEST_ROOT, 'sha256': build.digest(path)})

    def run(self, phase, command):
        path = self.root / 'logs' / ('chromium-lean-' + phase + '.log')
        with path.open('a') as log:
            log.write('\n=== ' + datetime.datetime.now(datetime.timezone.utc).isoformat() + ' ' + json.dumps([str(arg) for arg in command]) + ' ===\n')
            log.flush()
            child = subprocess.Popen([str(arg) for arg in command], cwd=self.src, env=self.env, stdout=log, stderr=subprocess.STDOUT)
            self.save(stage=phase + '-running', pid=child.pid, exitCode=None, log=str(path), finishedAt=None)
            print(json.dumps({'phase': phase, 'pid': child.pid, 'log': str(path)}), flush=True)
            code = child.wait()
        self.save(stage=phase + ('-complete' if code == 0 else '-failed'), pid=None, exitCode=code,
                  finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        if code:
            raise RuntimeError('Lean ' + phase + ' failed; inspect ' + str(path))

    def compile(self, jobs):
        jobs = lean.build_jobs(jobs)
        self.validate()
        self.prepare_root()
        self.candidate.save(ccTestsPassed=False, vizTestsPassed=False, stage='lean-compiled-candidate')
        self.save(compiled=False, ccTestsPassed=False, vizTestsPassed=False, jobs=jobs,
                  revision=build.CONFIG['revision'], candidateBinarySha256=self.candidate.state['binarySha256'],
                  profileSha256=self.candidate.state['profileSha256'], safetyStop=None)
        self.run('tests-configure', [self.src / 'buildtools/mac/gn', 'gen', lean.OUT,
                 '--root-target=' + TEST_LABEL, '--root-pattern=' + TEST_LABEL, '--fail-on-unused-args'])
        self.run('tests-build', [self.root / 'depot_tools/autoninja', '-C', lean.OUT,
                 'cc_unittests', 'viz_unittests', '-j', str(jobs)])
        self.validate()
        artifacts = {case['binary']: build.digest(self.output / case['binary']) for case in CASES.values()}
        self.save(compiled=True, artifacts=artifacts, stage='lean-tests-compiled')

    def test(self):
        self.validate()
        if self.state.get('candidateBinarySha256') != self.candidate.state['binarySha256'] or self.state.get('profileSha256') != self.candidate.state['profileSha256']:
            raise ValueError('C++ test binaries do not match the candidate configuration')
        for case in CASES.values():
            if self.state.get('artifacts', {}).get(case['binary']) != build.digest(self.output / case['binary']):
                raise ValueError('C++ test executable changed: ' + case['binary'])
        self.candidate.save(ccTestsPassed=False, vizTestsPassed=False, stage='lean-tests-running')
        self.save(ccTestsPassed=False, vizTestsPassed=False, results={})
        results = {}
        for name, case in CASES.items():
            xml = self.root / 'logs' / ('chromium-lean-' + name + '-tests.xml')
            # Remove the previous result so a crash cannot reuse a passing XML.
            with contextlib.suppress(FileNotFoundError):
                xml.unlink()
            self.run(name + '-tests', [self.output / case['binary'], '--single-process-tests',
                     '--test-launcher-jobs=1', '--gtest_filter=' + case['filter'], '--gtest_output=xml:' + str(xml)])
            results[name] = checked_xml(xml, case['count'])
            self.save(results=results)
        self.validate()
        evidence = {'version': 1, 'revision': build.CONFIG['revision'],
                    'binarySha256': self.candidate.state['binarySha256'],
                    'profileSha256': self.candidate.state['profileSha256'],
                    'testRoot': self.state['testRoot'], 'testArtifacts': self.state['artifacts'], 'results': results}
        self.candidate.save(stage='lean-engine-tests-complete', exitCode=0, ccTestsPassed=True, vizTestsPassed=True,
                            engineLayout='monolithic', cppTestsEvidence=evidence)
        self.save(stage='lean-tests-complete', compiled=True, ccTestsPassed=True, vizTestsPassed=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['build', 'test'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--jobs', type=lean.build_jobs, default=2)
    values = parser.parse_args()
    root = build.build_root(values.root)
    build.preflight(root, 80 if values.phase == 'build' else 0)
    with (root / '.virtual-desktop-build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runner = LeanTests(root)
        for path in [runner.candidate.state_path, runner.state_path]:
            if path.exists():
                pid = json.loads(path.read_text()).get('pid')
                if pid:
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(pid, 0)
                        raise RuntimeError('Another recorded build phase is active')
        if values.phase == 'build':
            runner.compile(values.jobs)
        else:
            runner.test()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError, ET.ParseError) as error:
        print('Lean tests: ' + str(error), file=sys.stderr)
        sys.exit(1)
