"""Offline deployment validation; never invokes installation or AWS."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).with_name('bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_bundle_refuses_wrong_hash_and_paths_or_links(self):
        for name, link in [('../escape.js', False), ('src/../../escape.js', False), ('src/link.js', True), ('private.pem', False)]:
            with tempfile.TemporaryDirectory() as tmp:
                raw = io.BytesIO()
                with tarfile.open(fileobj=raw, mode='w:gz') as tar:
                    entry = tarfile.TarInfo(name)
                    if link:
                        entry.type = tarfile.SYMTYPE; entry.linkname = '/etc/passwd'
                    tar.addfile(entry, io.BytesIO())
                p = Path(tmp) / 'bundle.tar.gz'; p.write_bytes(raw.getvalue())
                with self.assertRaises(ValueError):
                    bootstrap.bundle_files(p, '0' * 64)
                with self.assertRaises(ValueError):
                    bootstrap.bundle_files(p, hashlib.sha256(raw.getvalue()).hexdigest())

    def test_real_artifact_is_self_contained_and_units_guard_privilege_boundaries(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / 'runtime.tar.gz'
            with tarfile.open(evidence, 'w:gz') as tar:
                for name in [source / 'package.json', source / 'package-lock.json', *sorted((source / 'src').glob('*.js'))]:
                    tar.add(name, arcname=str(name.relative_to(source)))
            files = bootstrap.bundle_files(evidence, hashlib.sha256(evidence.read_bytes()).hexdigest())
        self.assertIn('src/verify-isolation.js', files)
        self.assertIn('src/credential-broker.js', files)
        for kind in ('writer', 'reader'):
            text = bootstrap.unit(kind, Path('/opt/fictitious-release'), Path('/opt/fictitious-node'))
            self.assertIn('IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128', text)
            self.assertIn('ExecStartPre=/opt/fictitious-node /opt/fictitious-release/src/verify-isolation.js ' + kind, text)
            self.assertIn('AWS_EC2_METADATA_DISABLED=true', text)
            self.assertNotIn('SupplementaryGroups=', text)
        text = bootstrap.unit('credentials', Path('/opt/fictitious-release'), Path('/opt/fictitious-node'))
        self.assertIn('RuntimeDirectoryMode=0711', text)
        self.assertNotIn('IPAddressDeny=', text)


if __name__ == '__main__':
    unittest.main()
