"""Explicit integration QA: real pinned Node/npm, temporary trees, non-login user; no AWS/app data."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).with_name('bootstrap.py'))
bootstrap = importlib.util.module_from_spec(spec); spec.loader.exec_module(bootstrap)


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('AUDIT_DEPENDENCY_INSTALL_QA') == '1', 'explicit root QA required')
class DependencyInstall(unittest.TestCase):
    def test_pinned_npm_config_regression_and_complete_nonlogin_install(self):
        node_dir = Path(os.environ['AUDIT_QA_NODE_DIR'])
        node = node_dir / 'bin/node'; npm = node_dir / 'lib/node_modules/npm/bin/npm-cli.js'
        owner = pwd.getpwnam('nobody'); source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='cc-audit-npm-ci-') as tmp:
            root = Path(tmp); root.chmod(0o711); release = root / 'release'; release.mkdir(mode=0o755)
            for name in ('package.json', 'package-lock.json'):
                dest = release / name; dest.write_bytes((source / name).read_bytes()); os.chown(dest, owner.pw_uid, owner.pw_gid)
            os.chown(release, owner.pw_uid, owner.pw_gid)
            original = subprocess.run(['runuser', '-u', owner.pw_name, '--', str(node), str(npm), '--version', '--userconfig=/dev/null', '--globalconfig=/dev/null'], cwd=release, env=bootstrap.ENV, capture_output=True, timeout=30)
            self.assertNotEqual(original.returncode, 0); self.assertIn(b'double-loading config', original.stderr)
            bootstrap.install_dependencies(node, node_dir, release, owner, root / 'cache')
            self.assertEqual((release / 'package-lock.json').read_bytes(), (source / 'package-lock.json').read_bytes())
            for name, version in json.loads((source / 'package.json').read_text())['dependencies'].items():
                self.assertEqual(json.loads((release / 'node_modules' / name / 'package.json').read_text())['version'], version)
            self.assertNotEqual((root / 'npm-user.npmrc').stat().st_ino, (root / 'npm-global.npmrc').stat().st_ino)
            self.assertEqual((root / 'npm-user.npmrc').read_bytes(), b''); self.assertEqual((root / 'npm-global.npmrc').read_bytes(), b'')


if __name__ == '__main__':
    unittest.main()
