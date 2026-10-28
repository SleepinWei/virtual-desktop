import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('lean_build', Path(__file__).with_name('lean-build.py'))
lean = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lean)


class LeanBuildPreservationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lean-build-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.src = self.root / 'chromium/src'
        self.src.mkdir(parents=True)
        (self.root / 'logs').mkdir()
        (self.src / 'engine.cc').write_text('tested source')
        config = dict(lean.build.CONFIG, revision='pinned-test', files={'engine.cc': {
            'patchedSha256': hashlib.sha256(b'tested source').hexdigest()}})
        self.config = patch.object(lean.build, 'CONFIG', config)
        self.config.start(); self.addCleanup(self.config.stop)
        self.head = patch.object(lean.build, 'capture', return_value='pinned-test')
        self.head.start(); self.addCleanup(self.head.stop)

    def test_lean_configuration_cannot_overwrite_a_custom_profile(self):
        runner = lean.LeanBuild(self.root)
        runner.output.mkdir(parents=True)
        args = runner.output / 'args.gn'; args.write_text('is_component_build = true\n')
        with self.assertRaisesRegex(ValueError, 'preserving'):
            runner.configure()
        self.assertEqual(args.read_text(), 'is_component_build = true\n')

    def test_candidate_state_and_output_do_not_replace_the_tested_build(self):
        state = self.root / 'chromium/virtual-desktop-build-state.json'
        state.write_text('{"compiled":true,"marker":"keep"}\n')
        original = state.read_bytes()
        runner = lean.LeanBuild(self.root)
        commands = []
        with patch.object(runner, 'run', side_effect=lambda phase, command: commands.append((phase, command))):
            runner.configure()
        self.assertEqual(state.read_bytes(), original)
        self.assertEqual(runner.state_path.name, 'virtual-desktop-lean-ninja-build-state.json')
        self.assertFalse(runner.state['compiled'])
        self.assertIn('--fail-on-unused-args', commands[0][1])
        self.assertIn('--root-pattern=//headless:headless_shell', commands[0][1])

    def test_changed_source_refuses_compilation_before_starting_a_tool(self):
        runner = lean.LeanBuild(self.root)
        (self.src / 'engine.cc').write_text('unreviewed local change')
        with patch.object(runner, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'source changed'):
                runner.compile()
            command.assert_not_called()

    def test_eight_jobs_reuses_the_candidate_directory_without_cleaning(self):
        runner = lean.LeanBuild(self.root)
        with patch.object(runner, 'run'):
            runner.configure()
        commands = []
        with patch.object(runner, 'run', side_effect=lambda phase, command: commands.append((phase, command))):
            with self.assertRaisesRegex(RuntimeError, 'without an executable'):
                runner.compile(8)
        self.assertEqual(commands[0][1][-2:], ['-j', '8'])
        self.assertEqual(commands[0][1][2], lean.OUT)
        self.assertEqual(runner.state['jobs'], 8)
        self.assertFalse(runner.state['compiled'])

    def test_jobs_outside_the_eight_command_budget_are_rejected(self):
        runner = lean.LeanBuild(self.root)
        for jobs in [0, 9, -1]:
            with patch.object(runner, 'run') as command:
                with self.assertRaisesRegex(ValueError, 'between 1 and 8'):
                    runner.compile(jobs)
                command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
