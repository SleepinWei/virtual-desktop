import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('canvaskit_build', Path(__file__).with_name('canvaskit-build.py'))
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class CanvasKitPreservationTest(unittest.TestCase):
    def test_patch_resumes_and_preserves_modified_skia_input(self):
        with tempfile.TemporaryDirectory(prefix='canvaskit-build-test-') as directory:
            root = Path(directory)
            src = root / 'chromium/src/third_party/skia'
            src.mkdir(parents=True)
            (root / 'canvaskit').mkdir()
            (root / 'logs').mkdir()
            original, modified = b'original\n', b'patched\n'
            file = src / 'font.cc'
            file.write_bytes(original)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=src)
            git('init', '-q')
            git('add', 'font.cc')
            git('-c', 'user.name=Local Test', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'baseline')
            file.write_bytes(modified)
            diff = root / 'font.patch'
            diff.write_bytes(git('diff'))
            file.write_bytes(original)
            source = {'patch': str(diff), 'files': {'font.cc': {
                'upstreamSha256': hashlib.sha256(original).hexdigest(),
                'patchedSha256': hashlib.sha256(modified).hexdigest()}}}
            with patch.object(build, 'SOURCE', source):
                runner = build.CanvasKitBuild(root)
                runner.apply()
                runner.apply()
                self.assertEqual(file.read_bytes(), modified)
                file.write_text('keep this local Skia work\n')
                with self.assertRaisesRegex(ValueError, 'refusing to overwrite'):
                    runner.apply()
                self.assertEqual(file.read_text(), 'keep this local Skia work\n')
