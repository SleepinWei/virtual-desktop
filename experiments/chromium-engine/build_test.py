import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('engine_build', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class BuildPreservationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='engine-build-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.src = self.root / 'chromium/src'
        self.src.mkdir(parents=True)
        (self.root / 'logs').mkdir()
        self.file = self.src / 'engine.cc'
        self.file.write_text('original\n')
        self.git('init', '-q')
        self.git('add', 'engine.cc')
        self.git('-c', 'user.name=Local Test', '-c', 'user.email=test@example.invalid',
                 'commit', '-qm', 'baseline')
        self.file.write_text('patched\n')
        patch_path = self.root / 'engine.patch'
        patch_path.write_text(self.git('diff'))
        self.file.write_text('original\n')
        self.config = dict(build.CONFIG, revision=self.git('rev-parse', 'HEAD').strip(),
                           patch=str(patch_path), files={'engine.cc': {
                               'upstreamSha256': hashlib.sha256(b'original\n').hexdigest(),
                               'patchedSha256': hashlib.sha256(b'patched\n').hexdigest()}})
        self.mock = patch.object(build, 'CONFIG', self.config)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.src, text=True)

    def test_patch_can_resume_without_overwriting_unrelated_work(self):
        unrelated = self.src / 'local-notes.txt'
        unrelated.write_text('keep my uncommitted notes\n')
        runner = build.Build(self.root)
        runner.apply()
        runner.apply()
        self.assertEqual(self.file.read_text(), 'patched\n')
        self.assertEqual(unrelated.read_text(), 'keep my uncommitted notes\n')
        self.assertEqual(json.loads(runner.state_path.read_text())['engineSplitGate'], 'not-passed')

    def test_changed_engine_input_is_preserved_on_patch_refusal(self):
        self.file.write_text('my existing engine modification\n')
        with self.assertRaisesRegex(ValueError, 'refusing to overwrite'):
            build.Build(self.root).apply()
        self.assertEqual(self.file.read_text(), 'my existing engine modification\n')

    def test_new_patch_fingerprint_cannot_reuse_previous_build_success(self):
        runner = build.Build(self.root)
        self.file.write_text('patched\n')
        runner.save(compiled=True, ccTestsPassed=True, vizTestsPassed=True, patchSha256='older patch')
        runner.apply()
        self.assertFalse(runner.state['compiled'])
        self.assertFalse(runner.state['ccTestsPassed'])
        self.assertFalse(runner.state['vizTestsPassed'])

    def test_custom_build_arguments_are_preserved(self):
        output = self.src / build.OUT
        output.mkdir(parents=True)
        args = output / 'args.gn'
        args.write_text('my_existing_build_argument = true\n')
        with self.assertRaisesRegex(ValueError, 'refusing to replace'):
            build.Build(self.root).configure()
        self.assertEqual(args.read_text(), 'my_existing_build_argument = true\n')


if __name__ == '__main__':
    unittest.main()
