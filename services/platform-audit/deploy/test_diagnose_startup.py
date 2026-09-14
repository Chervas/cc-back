"""Synthetic checks for the diagnostic's secret/log disclosure boundary."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('diagnose', Path(__file__).with_name('diagnose_startup.py'))
diagnose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnose)


class DiagnosticTests(unittest.TestCase):
    def test_log_and_property_output_never_contains_external_text(self):
        secret = 'FAKE_DO_NOT_RETURN_clinical_or_credential_value'
        messages = ['AUDIT_ISOLATION_CHECK_FAILED ' + secret,
                    'Failed at step NAMESPACE spawning ' + secret + ': Permission denied',
                    'Control process exited, code=exited, status=226/NAMESPACE', secret,
                    {'nested': secret}]
        raw = '\n'.join(json.dumps({'MESSAGE': m, 'EXTRA': secret}) for m in messages)
        result = diagnose.journal_summary(raw)
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(result['categories']['AUDIT_ISOLATION_CHECK_FAILED'], 1)
        self.assertEqual(result['categories']['process_exited_226'], 1)
        props = diagnose.safe_properties('Environment=' + secret + '\nResult=' + secret + '\nExecMainStatus=226\nExecStartPre={ argv[]=' + secret + '; code=exited; status=1 }')
        self.assertNotIn(secret, json.dumps(props))
        self.assertEqual(props['ExecMainStatus'], 226)
        self.assertEqual(props['ExecStartPre'], [{'code': 'exited', 'status': 1}])

    def test_secret_paths_and_symlinks_refused_before_content_read(self):
        with patch('builtins.open', side_effect=AssertionError('must not read')):
            for filename in ('/etc/clinicaclick-audit/writer/config.json', '/etc/clinicaclick-audit/writer/tls.key',
                             '/root/.aws/credentials', '/opt/clinicaclick-audit/release-69c48195d48d-recovery1/src/../.env'):
                self.assertEqual(diagnose.expected_hash(filename, '0' * 64), 'path_or_digest_refused')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'actual').mkdir(); (root / 'link').symlink_to(root / 'actual')
            self.assertEqual(diagnose.metadata(root / 'link' / 'config.json'), {'state': 'symlink_refused'})

    def test_collection_uses_only_allowlisted_read_commands(self):
        commands = []
        def command(args):
            commands.append(args)
            return 0, ''
        with patch.object(diagnose, 'command', side_effect=command), patch.object(diagnose, 'metadata', return_value={'state': 'missing'}), patch.object(diagnose.pwd, 'getpwnam', side_effect=KeyError):
            result = diagnose.collect({})
        self.assertEqual(len(commands), 8)
        for args in commands:
            self.assertIn(args[0], ('systemctl', 'journalctl', 'getenforce'))
            if args[0] == 'systemctl':
                self.assertIn(args[1], ('show', '--version'))
            elif args[0] == 'journalctl':
                self.assertIn(args[1], ['--unit=clinicaclick-audit-' + kind + '.service' for kind in diagnose.KINDS])
        self.assertEqual(result['status'], 'diagnostic_collected_not_repaired')
        self.assertFalse(result['serviceActions'])


if __name__ == '__main__':
    unittest.main()
