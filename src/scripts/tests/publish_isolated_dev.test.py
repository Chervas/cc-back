#!/usr/bin/python3
"""Temporary-filesystem publication; no real Git, services, HTTP or SQL."""
import contextlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import types
import unittest
import urllib.error
from unittest import mock


class PublishPermissionsTest(unittest.TestCase):
    def test_genuine_main_overrides_incoming_private_umask_for_public_code(self):
        script = pathlib.Path(__file__).resolve().parents[3] / 'ops/security/publish-isolated-dev.py'
        publisher = types.ModuleType('TEST_ONLY_isolated_publisher')
        exec(compile(script.read_bytes(), str(script), 'exec'), publisher.__dict__)
        with tempfile.TemporaryDirectory(prefix='cc-publish-permissions-') as tmp:
            root = pathlib.Path(tmp)
            publisher.SOURCE = root / 'source'
            publisher.SOURCE.mkdir()
            publisher.ROOT = root / 'runtime'
            publisher.ROOT.mkdir()
            previous = publisher.ROOT / 'release-previous'
            previous.mkdir()
            (publisher.ROOT / 'current').symlink_to(previous)
            commit = 'b' * 40
            target = publisher.ROOT / ('release-' + commit)
            code = {
                'package.json': b'{}\n', 'package-lock.json': b'{}\n',
                'src/scripts/security-schema-release.js': b'// TEST_ONLY metadata CLI\n',
                'services/fixture/src/main.js': b'// TEST_ONLY collector\n',
                'models/fixture.js': b'// TEST_ONLY model\n',
                'migrations/fixture.js': b'// TEST_ONLY migration\n',
                'config/fixture.js': b'// TEST_ONLY config\n',
                'ops/security/schema-contract.json': b'{}\n',
            }
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w') as tar:
                for name, content in code.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(content)
                    member.mode = 0o644
                    tar.addfile(member, io.BytesIO(content))
            calls = []

            def fake_command(args, **_options):
                calls.append(args)
                if args[0] == 'git':
                    if args[-2:] == ['status', '--porcelain']:
                        output = b''
                    elif args[-2:] == ['rev-parse', 'HEAD']:
                        output = commit.encode() + b'\n'
                    elif args[-2:] == ['archive', 'HEAD']:
                        output = archive.getvalue()
                    else:
                        raise AssertionError('unexpected Git fixture command')
                elif args[0] == '/usr/bin/node':
                    self.assertEqual(args[1], str(target / 'src/scripts/security-schema-release.js'))
                    self.assertTrue(pathlib.Path(args[1]).is_file())
                    self.assertEqual(args[2:5], ['check', '--runtime', 'dev'])
                    output = b'{"compatible":true}\n'
                elif args[0] == 'systemctl':
                    self.assertIn(args[-1], ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service'])
                    output = b'active\n'
                else:
                    raise AssertionError('real child command forbidden')
                return subprocess.CompletedProcess(args, 0, output, b'')

            actual_is_file = pathlib.Path.is_file

            def configuration_exists(path):
                return True if str(path) == '/etc/clinicaclick-dev/runtime.env' else actual_is_file(path)

            def readiness(url, **_options):
                self.assertEqual(url, 'http://127.0.0.1:3004/api/auth/me')
                raise urllib.error.HTTPError(url, 401, 'TEST_ONLY', {}, None)

            incoming = os.umask(0o077)
            try:
                with mock.patch.object(publisher.os, 'geteuid', return_value=0), \
                     mock.patch.object(publisher.sys, 'argv', [str(script)]), \
                     mock.patch.object(pathlib.Path, 'is_file', configuration_exists), \
                     mock.patch.object(publisher.subprocess, 'run', side_effect=fake_command), \
                     mock.patch.object(publisher.urllib.request, 'urlopen', side_effect=readiness), \
                     mock.patch.object(publisher.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()) as output:
                    publisher.main()
                self.assertEqual(json.loads(output.getvalue())['status'], 'isolated_dev_published')
                self.assertEqual((publisher.ROOT / 'current').resolve(), target)
                self.assertEqual(target.stat().st_mode & 0o777, 0o755)
                for path in target.rglob('*'):
                    self.assertEqual(path.stat().st_mode & 0o777, 0o755 if path.is_dir() else 0o644, str(path.relative_to(target)))
                for relative, content in code.items():
                    self.assertEqual((target / relative).read_bytes(), content)
                self.assertEqual(json.loads((target / 'release.json').read_text())['commit'], commit)
                self.assertTrue(any(args[:2] == ['systemctl', 'start'] for args in calls))
            finally:
                os.umask(incoming)


if __name__ == '__main__':
    unittest.main()
