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
import hashlib
import stat
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


class DependencyBundleTest(unittest.TestCase):
    """Synthetic package trees and mocked smoke child, never a real publication."""
    def setUp(self):
        script = pathlib.Path(__file__).resolve().parents[3] / 'ops/security/publish-isolated-dev.py'
        self.publisher = types.ModuleType('TEST_ONLY_dependency_bundle')
        exec(compile(script.read_bytes(), str(script), 'exec'), self.publisher.__dict__)
        self.temp = tempfile.TemporaryDirectory(prefix='cc-dependency-bundle-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.publisher.ROOT = self.root / 'runtime'
        self.bundle = self.publisher.ROOT / 'dependency-bundles' / 'email-test'
        self.bundle.mkdir(parents=True)
        self.candidate = self.publisher.ROOT / 'release-candidate'
        self.candidate.mkdir()
        for directory in [self.bundle, self.candidate]:
            (directory / 'package.json').write_text('{"name":"synthetic-only"}\n')
            (directory / 'package-lock.json').write_text('{"lockfileVersion":3}\n')
        (self.bundle / 'node_modules' / 'fixture').mkdir(parents=True)
        (self.bundle / 'node_modules' / 'fixture' / 'index.js').write_text('// FICTITIOUS MODULE, never executed\n')
        (self.bundle / 'node_modules' / '.bin').mkdir()
        (self.bundle / 'node_modules' / '.bin' / 'fixture').symlink_to('../fixture/index.js')
        self.manifest = {
            'schema': 1,
            'lock_sha256': self.publisher.sha256(self.bundle / 'package-lock.json'),
            'package_sha256': self.publisher.sha256(self.bundle / 'package.json'),
            'node_major': 22,
            'smoke_verified': True,
        }
        self.write_manifest()
        self.metadata_overrides = {}
        original_lstat = pathlib.Path.lstat

        def synthetic_root_metadata(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            values = list(info)
            values[4] = 0
            if not stat.S_ISLNK(values[0]):
                values[0] &= ~0o022
            override = self.metadata_overrides.get(str(path), {})
            values[4] = override.get('uid', values[4])
            values[0] = override.get('mode', values[0])
            return os.stat_result(values)

        patch = mock.patch.object(pathlib.Path, 'lstat', synthetic_root_metadata)
        patch.start()
        self.addCleanup(patch.stop)
        self.smoke_response = subprocess.CompletedProcess([], 0, json.dumps({
            'node_major': 22, 'modules': ['sharp', 'bcrypt', 'postcss', 'htmlparser2', 'sanitize-html'],
        }).encode(), b'')

    def write_manifest(self):
        (self.bundle / 'dependency-bundle.json').write_text(json.dumps(self.manifest))

    def validate(self):
        return self.publisher.validate_dependency_bundle(str(self.bundle), self.candidate)

    def test_valid_candidate_pinned_bundle_runs_actual_smoke_command_with_no_inherited_secrets(self):
        with mock.patch.dict(os.environ, {'AWS_SECRET_ACCESS_KEY': 'TEST_ONLY_NOT_FOR_CHILD', 'NODE_OPTIONS': '--invalid-test-only'}), \
             mock.patch.object(self.publisher.subprocess, 'run', return_value=self.smoke_response) as child:
            self.assertEqual(self.validate(), self.bundle)
        args, options = child.call_args
        self.assertEqual(args[0][:2], ['/usr/bin/node', '-e'])
        self.assertEqual(args[0][-1], str(self.bundle))
        self.assertEqual(options['cwd'], str(self.bundle))
        self.assertEqual(options['env'], {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8', 'NODE_ENV': 'test'})
        self.assertEqual(options['timeout'], 30)
        for module in ['sharp', 'bcrypt', 'postcss', 'htmlparser2', 'sanitize-html']:
            self.assertIn(module, args[0][2])

    def test_missing_malformed_or_truthy_forged_manifest_fails_before_running_dependencies(self):
        for manifest in [None, [], {**self.manifest, 'schema': True}, {**self.manifest, 'node_major': '22'},
                         {**self.manifest, 'smoke_verified': 1}, {**self.manifest, 'lock_sha256': 'x' * 64},
                         {**self.manifest, 'skip_checks': True}]:
            with self.subTest(manifest=manifest):
                (self.bundle / 'dependency-bundle.json').write_text(json.dumps(manifest))
                with mock.patch.object(self.publisher.subprocess, 'run') as child, self.assertRaisesRegex(RuntimeError, 'manifest_invalid'):
                    self.validate()
                child.assert_not_called()
        (self.bundle / 'dependency-bundle.json').write_text('{broken-json')
        with self.assertRaisesRegex(RuntimeError, 'manifest_invalid'):
            self.validate()
        (self.bundle / 'dependency-bundle.json').unlink()
        with self.assertRaisesRegex(RuntimeError, 'manifest_invalid'):
            self.validate()

    def test_manifest_pin_must_match_both_bundle_bytes_and_candidate_bytes(self):
        for filename in ['package.json', 'package-lock.json']:
            with self.subTest(filename=filename):
                path = self.candidate / filename
                original = path.read_bytes()
                path.write_text('{"differentCandidate":true}')
                with mock.patch.object(self.publisher.subprocess, 'run') as child, self.assertRaisesRegex(RuntimeError, 'hash_mismatch'):
                    self.validate()
                child.assert_not_called()
                path.write_bytes(original)
        (self.bundle / 'package-lock.json').write_text('{"tamperedBundle":true}')
        with self.assertRaisesRegex(RuntimeError, 'hash_mismatch'):
            self.validate()

    def test_unowned_or_group_writable_manifest_module_or_parent_is_rejected(self):
        for path, override in [
            (self.bundle, {'uid': 1000}),
            (self.bundle.parent, {'mode': stat.S_IFDIR | 0o775}),
            (self.bundle / 'dependency-bundle.json', {'uid': 1000}),
            (self.bundle / 'node_modules' / 'fixture' / 'index.js', {'mode': stat.S_IFREG | 0o666}),
        ]:
            with self.subTest(path=path):
                self.metadata_overrides[str(path)] = override
                with mock.patch.object(self.publisher.subprocess, 'run') as child, self.assertRaisesRegex(RuntimeError, 'untrusted_owner_or_mode'):
                    self.validate()
                child.assert_not_called()
                self.metadata_overrides.clear()

    def test_outside_module_links_and_symlink_bundle_directory_are_rejected(self):
        outside = self.root / 'outside.js'
        outside.write_text('// OUTSIDE SYNTHETIC TREE')
        link = self.bundle / 'node_modules' / 'escape.js'
        link.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, 'symlink_outside_modules'):
            self.validate()
        link.unlink()
        alias = self.bundle.parent / 'alias'
        alias.symlink_to(self.bundle, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'directory_symlink'):
            self.publisher.validate_dependency_bundle(str(alias), self.candidate)
        with self.assertRaisesRegex(RuntimeError, 'path_invalid'):
            self.publisher.validate_dependency_bundle(str(self.root / 'outside'), self.candidate)

    def test_smoke_verified_manifest_is_not_a_substitute_for_working_native_modules(self):
        for response in [subprocess.CompletedProcess([], 1, b'', b'PRIVATE FIXTURE ERROR'),
                         subprocess.CompletedProcess([], 0, b'{"node_major":18}', b'')]:
            with mock.patch.object(self.publisher.subprocess, 'run', return_value=response), self.assertRaisesRegex(RuntimeError, '^dependency_bundle_smoke_failed$'):
                self.validate()

    def test_copy_is_independent_and_rebases_absolute_internal_links_into_new_target(self):
        absolute = self.bundle / 'node_modules' / '.bin' / 'absolute'
        original = self.bundle / 'node_modules' / 'fixture' / 'index.js'
        absolute.symlink_to(original)
        with mock.patch.object(self.publisher.subprocess, 'run', return_value=self.smoke_response):
            bundle = self.validate()
        self.publisher.copy_bundle_modules(bundle, self.candidate)
        copied = self.candidate / 'node_modules' / 'fixture' / 'index.js'
        self.assertNotEqual(original.stat().st_ino, copied.stat().st_ino)
        self.assertEqual((self.candidate / 'node_modules' / '.bin' / 'absolute').resolve(), copied)
        self.assertEqual(absolute.resolve(), original)
        copied.write_text('// ONLY NEW RELEASE')
        self.assertNotEqual(original.read_bytes(), copied.read_bytes())

    def test_without_flag_changed_lock_is_still_rejected_and_subservice_lock_cannot_use_root_bundle(self):
        previous = self.publisher.ROOT / 'release-previous'
        previous.mkdir()
        (previous / 'package-lock.json').write_text('{"old":true}')
        (previous / 'node_modules').mkdir()
        (self.candidate / 'services' / 'broker').mkdir(parents=True)
        with self.assertRaisesRegex(AssertionError, 'Dependency lock changed'):
            self.publisher.install_dependencies(previous, self.candidate)
        broker = previous / 'services' / 'broker'
        (broker / 'node_modules').mkdir(parents=True)
        (broker / 'package-lock.json').write_text('{"brokerOld":true}')
        (self.candidate / 'services' / 'broker' / 'package-lock.json').write_text('{"brokerNew":true}')
        with mock.patch.object(self.publisher, 'copy_bundle_modules') as copy, self.assertRaisesRegex(AssertionError, 'Dependency lock changed'):
            self.publisher.install_dependencies(previous, self.candidate, self.bundle)
        copy.assert_called_once_with(self.bundle, self.candidate)

    def test_without_flag_unchanged_dependencies_keep_existing_copy_contract(self):
        previous = self.publisher.ROOT / 'release-previous'
        previous.mkdir()
        (previous / 'package-lock.json').write_bytes((self.candidate / 'package-lock.json').read_bytes())
        (previous / 'node_modules').mkdir()
        module = previous / 'node_modules' / 'unchanged.js'
        module.write_text('// SAME LOCK FIXTURE')
        (self.candidate / 'services').mkdir()
        self.publisher.install_dependencies(previous, self.candidate)
        copied = self.candidate / 'node_modules' / 'unchanged.js'
        self.assertEqual(copied.read_bytes(), module.read_bytes())
        self.assertEqual(copied.stat().st_ino, module.stat().st_ino)


if __name__ == '__main__':
    unittest.main()
