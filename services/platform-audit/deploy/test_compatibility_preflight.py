import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('audit_preflight', Path(__file__).with_name('compatibility_preflight.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Preflight(unittest.TestCase):
    def test_reads_executed_override_and_source_hashes_without_private_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / 'release-live-reader'
            (release / 'src').mkdir(parents=True)
            entry = release / 'src' / 'reader-main.js'
            entry.write_text('// fictitious source')
            for name in ['package.json', 'package-lock.json']:
                (release / name).write_text('{}')
            binary = root / 'node-v24.21.0' / 'bin' / 'node'
            binary.parent.mkdir(parents=True)
            binary.write_text('fictitious, never executed')
            binary.chmod(0o755)
            (root / 'reader').mkdir()
            properties = ('ActiveState=active\nSubState=running\nUser=reader\nGroup=reader\n'
                          'WorkingDirectory=/old-release\nNRestarts=0\n'
                          f'ExecStart={{ path={binary} ; argv[]={binary} {entry} /private/SENTINEL_CONFIG ; }}')
            def output(*args):
                return properties if args[0] == 'systemctl' else 'v24.21.0'
            with patch.object(MODULE, 'BASE', root), patch.object(MODULE, 'STATE', root), patch.object(MODULE, 'output', output), \
                    patch.object(MODULE.subprocess, 'check_output', return_value=json.dumps({'referenceVersions': [26, 27], 'delegationCodec': True})):
                result = MODULE.inventory('reader')
            self.assertEqual(result['executedRelease'], str(release))
            self.assertEqual(len(result['sources']), 3)
            self.assertNotIn('SENTINEL', json.dumps(result))
            self.assertNotIn('ExecStart', result['unitMetadata'])
            self.assertEqual(result['compatibility']['referenceVersions'], [26, 27])

    def test_unknown_entrypoint_is_rejected_before_any_node_or_configuration_operation(self):
        with patch.object(MODULE, 'output', return_value='ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /foreign/script.js ; }'):
            with self.assertRaisesRegex(ValueError, 'executed_release'):
                MODULE.inventory('reader')


if __name__ == '__main__':
    unittest.main()
