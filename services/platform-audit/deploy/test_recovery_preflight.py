"""Explicit root QA of recovery safety, using temporary paths and fictitious service identities."""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).with_name('bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec); spec.loader.exec_module(bootstrap)


class Sanitization(unittest.TestCase):
    def test_error_reason_never_exposes_arbitrary_subprocess_or_exception_text(self):
        self.assertEqual(bootstrap.failure_reason(ValueError('FICTITIOUS_SECRET_VALUE')), 'bootstrap_step_failed')
        self.assertEqual(bootstrap.failure_reason(ValueError('partial_source_changed')), 'partial_source_changed')


@unittest.skipUnless(os.geteuid() == 0, 'explicit root QA required; no host users/services are changed')
class RecoveryPreflight(unittest.TestCase):
    def test_exact_partial_state_accepted_and_divergent_or_configured_state_rejected(self):
        digest = bootstrap.RECOVERABLE_ARTIFACT
        with tempfile.TemporaryDirectory(prefix='cc-audit-recovery-preflight-') as tmp:
            root = Path(tmp); base = root / 'opt'; config = root / 'config'; state = root / 'state'
            for p, mode in [(base, 0o755), (config, 0o711), (state, 0o711)]:
                p.mkdir(); p.chmod(mode)
            (base / ('node-v' + bootstrap.NODE_VERSION)).mkdir()
            old = base / ('release-' + digest[:12]); (old / 'src').mkdir(parents=True)
            files = {'package.json': b'{}', 'package-lock.json': b'{}', 'src/fixture.js': b'// fictitious'}
            owners = {name: SimpleNamespace(pw_name=name, pw_uid=43011 + i, pw_gid=43011 + i, pw_dir='/nonexistent', pw_shell='/sbin/nologin') for i, name in enumerate(bootstrap.USERS.values())}
            for name, content in files.items():
                p = old / name; p.write_bytes(content); os.chown(p, 43011, 43011)
            groups = lambda name, gid: [43011, 43012, 43013] if name == 'cc-audit-credentials' else [gid]
            with patch.multiple(bootstrap, BASE=base, CONFIG=config, STATE=state), patch.object(bootstrap.pwd, 'getpwnam', side_effect=owners.__getitem__), patch.object(bootstrap.grp, 'getgrnam', side_effect=lambda name: SimpleNamespace(gr_gid=owners[name].pw_gid)), patch.object(bootstrap.os, 'getgrouplist', side_effect=groups):
                bootstrap.recovery_preflight(files, digest)
                (old / 'src/fixture.js').write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'partial_source_changed'):
                    bootstrap.recovery_preflight(files, digest)
                (old / 'src/fixture.js').write_bytes(files['src/fixture.js'])
                (config / 'writer').mkdir()
                with self.assertRaisesRegex(ValueError, 'configuration_already_started'):
                    bootstrap.recovery_preflight(files, digest)
                (config / 'writer').rmdir()
                (base / ('release-' + digest[:12] + '-recovery1')).mkdir()
                with self.assertRaisesRegex(ValueError, 'unexpected_partial_installation'):
                    bootstrap.recovery_preflight(files, digest)


if __name__ == '__main__':
    unittest.main()
