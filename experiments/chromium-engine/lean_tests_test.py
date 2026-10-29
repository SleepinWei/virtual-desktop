import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('lean_tests', Path(__file__).with_name('lean-tests.py'))
lean_tests = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lean_tests)


class LeanTestsEvidenceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lean-tests-evidence-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'chromium/src').mkdir(parents=True)

    def test_xml_requires_the_full_non_skipped_successful_test_count(self):
        xml = self.root / 'result.xml'
        passing = '<testsuites><testsuite><testcase classname="RemotePaint" name="Records" status="run" result="completed"/></testsuite></testsuites>'
        xml.write_text(passing)
        self.assertEqual(lean_tests.checked_xml(xml, 1)['count'], 1)
        for contents in [passing.replace('status="run"', 'status="notrun"'),
                         passing.replace('/>', '><skipped/></testcase>'),
                         passing.replace('/>', '><failure/></testcase>'), '<testsuites/>']:
            xml.write_text(contents)
            with self.assertRaisesRegex(ValueError, 'required tests'):
                lean_tests.checked_xml(xml, 1)
        xml.write_text(passing)
        with self.assertRaisesRegex(ValueError, 'required tests'):
            lean_tests.checked_xml(xml, 17)

    def test_test_state_is_separate_and_custom_root_is_preserved(self):
        original = self.root / 'chromium/virtual-desktop-build-state.json'
        candidate = self.root / 'chromium/virtual-desktop-lean-ninja-build-state.json'
        original.write_text('{"compiled":true,"marker":"original"}')
        candidate.write_text('{"compiled":true,"marker":"candidate"}')
        runner = lean_tests.LeanTests(self.root)
        runner.prepare_root(); runner.prepare_root()
        runner.save(compiled=False, stage='safety-stopped')
        self.assertEqual(json.loads(original.read_text())['marker'], 'original')
        self.assertTrue(json.loads(candidate.read_text())['compiled'])
        root = runner.src / lean_tests.TEST_ROOT
        root.write_text('preserve custom GN root')
        with self.assertRaisesRegex(ValueError, 'Preserving custom'):
            runner.prepare_root()
        self.assertEqual(root.read_text(), 'preserve custom GN root')


if __name__ == '__main__':
    unittest.main()
