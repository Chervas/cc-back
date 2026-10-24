"""Local fixture PKI tests. No production paths, network, AWS or real credentials."""
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import signal
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def module(name):
    out = types.ModuleType(name.replace('-', '_'))
    out.__file__ = str(HERE / (name + '.py'))
    exec(compile(Path(out.__file__).read_bytes(), out.__file__, 'exec'), out.__dict__)
    return out


C = module('credential-process')
R = module('rotate-certificate')
REAL_RUN = subprocess.run


def credentials(ttl=900):
    return {'Version': 1, 'AccessKeyId': 'ASIA' + 'A' * 16, 'SecretAccessKey': 'B' * 40,
            'SessionToken': 'C' * 64,
            'Expiration': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=ttl)).isoformat().replace('+00:00', 'Z')}


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0, 'Run fixture tests using sudo; never use production PKI paths.')
        original_signal = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, original_signal)
        self.tmp = tempfile.TemporaryDirectory(prefix='cc-cost-pki-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.base = self.root / 'costs'
        self.base.mkdir(mode=0o750)
        os.chown(self.base, 0, 1000)
        self.authority = self.base / 'authority'
        self.authority.mkdir(mode=0o700)
        self.identities = self.base / 'identities'
        self.identities.mkdir(mode=0o750)
        os.chown(self.identities, 0, 1000)
        os.chmod(self.identities, 0o750)
        for m in [C, R]:
            for k, v in [('BASE', self.base), ('IDENTITIES', self.identities), ('CURRENT', self.base / 'current')]:
                p = patch.object(m, k, v)
                p.start()
                self.addCleanup(p.stop)
        for m, k in [(C, 'directories'), (R, 'directory')]:
            p = patch.object(m, k, self.fixture_directories)
            p.start()
            self.addCleanup(p.stop)
        for m, k, v in [(C, 'CONFIG', self.base / 'roles-anywhere.json'), (R, 'AUTHORITY', self.authority)]:
            p = patch.object(m, k, v)
            p.start()
            self.addCleanup(p.stop)
        self.cfg = {'schema': 'clinicaclick-cost-roles-anywhere/1', 'roleArn': C.ROLE, 'region': C.REGION,
                    'durationSeconds': 900,
                    'trustAnchorArn': 'arn:aws:rolesanywhere:eu-west-3:137819318729:trust-anchor/11111111-1111-4111-8111-111111111111',
                    'profileArn': 'arn:aws:rolesanywhere:eu-west-3:137819318729:profile/22222222-2222-4222-8222-222222222222'}
        self.write(C.CONFIG, json.dumps(self.cfg).encode(), 0o644)

    def fixture_directories(self, p):
        # Tests replace only the trusted anchor (/tmp is intentionally not trusted in production).
        p = Path(p)
        self.assertTrue(p == self.root or self.root in p.parents)
        C.require(p.resolve(strict=True) == p)
        for q in [p] + [x for x in p.parents if x == self.root or self.root in x.parents]:
            s = q.lstat()
            C.require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)

    def write(self, p, data, mode, gid=0):
        p.write_bytes(data)
        os.chown(p, 0, gid)
        os.chmod(p, mode)

    def ca(self):
        config = self.authority / 'request.cnf'
        self.write(config, ('[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=' + R.ISSUER + '\n').encode(), 0o600)
        REAL_RUN(['/usr/bin/openssl', 'req', '-x509', '-config', str(config), '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
                  '-nodes', '-keyout', str(self.authority / 'ca-key.pem'), '-out', str(self.authority / 'ca.pem'),
                  '-days', '365', '-sha256', '-subj', '/CN=' + R.ISSUER,
                  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                  '-addext', 'subjectKeyIdentifier=hash'],
                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, env=R.ENV)
        for name in ['ca-key.pem', 'ca.pem']:
            os.chmod(self.authority / name, 0o600)

    def active(self):
        self.ca()
        result = R.rotate()
        self.assertTrue(result['rotated'])
        return (self.base / 'current').resolve()

    def test_config_fixed_scope_and_duplicate_keys(self):
        self.assertEqual(C.read_config(), self.cfg)
        self.write(C.CONFIG, b'{"schema":1,"schema":2}', 0o644)
        with self.assertRaises(ValueError):
            C.read_config()
        self.cfg['trustAnchorArn'] = self.cfg['trustAnchorArn'].replace('137819318729', '000000000000')
        self.write(C.CONFIG, json.dumps(self.cfg).encode(), 0o644)
        with self.assertRaises(ValueError):
            C.read_config()

    def test_config_no_extra_options_or_long_session(self):
        for change in [{'durationSeconds': 3600}, {'endpoint': 'https://example.invalid'}, {'durationSeconds': True}]:
            bad = dict(self.cfg, **change)
            self.write(C.CONFIG, json.dumps(bad).encode(), 0o644)
            with self.assertRaises(ValueError):
                C.read_config()

    def test_no_symlink_or_writable_file(self):
        p = self.base / 'file'
        self.write(p, b'fixture', 0o644)
        link = self.base / 'link'
        link.symlink_to('file')
        with self.assertRaises(ValueError):
            C.open_checked(link, 0o644)
        os.chmod(p, 0o664)
        with self.assertRaises(ValueError):
            C.open_checked(p, 0o644)

    def test_credential_expiry_and_shape_fail_closed(self):
        self.assertEqual(C.validate_credentials(json.dumps(credentials()).encode())['Version'], 1)
        for ttl in [-1, 50, 3600]:
            with self.assertRaises(ValueError):
                C.validate_credentials(json.dumps(credentials(ttl)).encode())
        raw = json.dumps(credentials()).encode()
        with self.assertRaises(ValueError):
            C.validate_credentials(raw[:-1] + b',"Version":1}')
        bad = credentials()
        bad['SessionToken'] = 'fixture\nsecret'
        with self.assertRaises(ValueError):
            C.validate_credentials(json.dumps(bad).encode())

    def test_initial_rotation_cert_chain_extensions_modes_and_noop(self):
        version = self.active()
        self.assertEqual(stat.S_IMODE(version.stat().st_mode), 0o750)
        self.assertEqual(version.stat().st_gid, 1000)
        for name, mode in [('leaf.pem', 0o444), ('leaf.key', 0o440)]:
            self.assertEqual(stat.S_IMODE((version / name).stat().st_mode), mode)
            self.assertEqual((version / name).stat().st_gid, 1000)
        cert = os.open(version / 'leaf.pem', os.O_RDONLY)
        try:
            C.certificate_info(cert)
        finally:
            os.close(cert)
        before = (version / 'leaf.key').stat().st_ino
        self.assertFalse(R.rotate()['rotated'])
        self.assertEqual((version / 'leaf.key').stat().st_ino, before)
        self.assertEqual(list(self.identities.glob('.pending-*')), [])

    def test_new_identity_parent_under_umask077_readable_by_real_uid1000(self):
        self.identities.rmdir()
        os.chown(self.root, 0, 1000)
        os.chmod(self.root, 0o750)
        os.chmod(self.base, 0o750)
        original_umask = os.umask(0o077)
        try:
            version = self.active()
            self.assertEqual(stat.S_IMODE(self.identities.stat().st_mode), 0o750)
            child = os.fork()
            if child == 0:
                try:
                    os.setgroups([])
                    os.setgid(1000)
                    os.setuid(1000)
                    for name in ['leaf.pem', 'leaf.key']:
                        fd = os.open(version / name, os.O_RDONLY | os.O_NOFOLLOW)
                        os.close(fd)
                    os._exit(0)
                except BaseException:
                    os._exit(1)
            _, status = os.waitpid(child, 0)
            self.assertTrue(os.WIFEXITED(status))
            self.assertEqual(os.WEXITSTATUS(status), 0)
        finally:
            os.umask(original_umask)

    def test_existing_identity_parent_wrong_mode_refused_without_chmod(self):
        self.ca()
        os.chmod(self.identities, 0o700)
        with self.assertRaises(ValueError):
            R.rotate()
        self.assertEqual(stat.S_IMODE(self.identities.stat().st_mode), 0o700)

    def test_fd_pair_survives_atomic_rotation_with_new_key(self):
        old = self.active()
        _v, cert, key = C.open_identity()
        old_cert = os.read(cert, 16384)
        old_key = os.read(key, 8192)
        actual_check = R.check_leaf
        count = [0]
        def check(*args, **kwargs):
            value = actual_check(*args, **kwargs)
            count[0] += 1
            return dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=6) if count[0] == 1 else value
        with patch.object(R, 'check_leaf', check):
            self.assertTrue(R.rotate()['rotated'])
        new = (self.base / 'current').resolve()
        self.assertNotEqual(new, old)
        self.assertNotEqual((new / 'leaf.key').read_bytes(), old_key)
        os.lseek(cert, 0, 0)
        os.lseek(key, 0, 0)
        self.assertEqual(os.read(cert, 16384), old_cert)
        self.assertEqual(os.read(key, 8192), old_key)
        os.close(cert)
        os.close(key)
        self.assertTrue(old.exists())

    def test_rotation_failure_preserves_current_and_removes_pending(self):
        old = self.active()
        actual_check = R.check_leaf
        def expiring(*args, **kwargs):
            actual_check(*args, **kwargs)
            return dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=6)
        actual_run = R.run
        def fail_new_key(args, *rest, **kwargs):
            if args[0] == 'req':
                raise RuntimeError('synthetic signing failure')
            return actual_run(args, *rest, **kwargs)
        with patch.object(R, 'check_leaf', expiring), patch.object(R, 'run', fail_new_key):
            with self.assertRaises(RuntimeError):
                R.rotate()
        self.assertEqual((self.base / 'current').resolve(), old)
        self.assertEqual(list(self.identities.glob('.pending-*')), [])

    def test_invalid_existing_private_key_mode_rejected(self):
        old = self.active()
        os.chmod(old / 'leaf.key', 0o444)
        with self.assertRaises(ValueError):
            R.rotate()
        with self.assertRaises(ValueError):
            C.open_identity()

    def test_current_escape_rejected(self):
        (self.base / 'current').symlink_to('../outside')
        (self.root / 'outside').mkdir()
        with self.assertRaises(ValueError):
            C.open_identity()

    def test_helper_uses_same_fd_pair_sanitized_environment_and_fixed_args(self):
        self.active()
        installed = self.base / 'credential-wrapper'
        self.write(installed, b'fixture-wrapper', 0o755)
        calls = []
        def execute(args, **kwargs):
            if args[0] == '/usr/bin/openssl':
                return REAL_RUN(args, **kwargs)
            calls.append((args, kwargs))
            self.assertEqual(args[:4], [str(C.LOADER), '--library-path', str(C.LIBRARY), str(C.HELPER)])
            self.assertEqual(args[4], 'credential-process')
            self.assertEqual(args[-2:], ['--session-duration', '900'])
            self.assertEqual(kwargs['env'], C.CHILD_ENV)
            self.assertEqual(len(kwargs['pass_fds']), 2)
            for fd in kwargs['pass_fds']:
                self.assertTrue(stat.S_ISREG(os.fstat(fd).st_mode))
            return subprocess.CompletedProcess(args, 0, json.dumps(credentials()).encode(), b'')
        with patch.object(C, 'SELF', installed), patch.object(C, 'pinned_runtime'), patch.object(C.os, 'getuid', return_value=1000), patch.object(C.os, 'geteuid', return_value=1000), patch.dict(os.environ, {'AWS_ACCESS_KEY_ID': 'DO-NOT-INHERIT', 'HTTPS_PROXY': 'DO-NOT-INHERIT', 'LD_PRELOAD': 'DO-NOT-INHERIT'}):
            self.assertEqual(C.credentials(execute)['Version'], 1)
        self.assertEqual(len(calls), 1)
        for fd in calls[0][1]['pass_fds']:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_main_never_echoes_helper_error_or_credentials(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(C, 'credentials', side_effect=RuntimeError('SYNTHETIC-SECRET')), patch.object(C.sys, 'argv', ['fixed']), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(C.main(), 1)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(err.getvalue(), 'cost_credentials_unavailable\n')

    def test_sigterm_closes_owned_subprocess(self):
        pidfile = self.root / 'fixture-child-pid'
        code = ('import sys,time,os;open(sys.argv[1],"w").write(str(os.getpid()));time.sleep(30)')
        wrapper = ('import sys,types; p=sys.argv[1];m=types.ModuleType("fixture");'
                   'exec(compile(open(p,"rb").read(),p,"exec"),m.__dict__);'
                   'args=[sys.executable,"-c",sys.argv[2],sys.argv[3]];'
                   'm.credentials=lambda:m.subprocess.run(args,'
                   'stdout=m.subprocess.PIPE,stderr=m.subprocess.PIPE,timeout=30);sys.argv=[p];sys.exit(m.main())')
        p = subprocess.Popen([sys.executable, '-B', '-c', wrapper, str(HERE / 'credential-process.py'), code, str(pidfile)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=C.CHILD_ENV)
        try:
            deadline = time.monotonic() + 3
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(pidfile.exists())
            child = int(pidfile.read_text())
            p.send_signal(signal.SIGTERM)
            out, err = p.communicate(timeout=2)
            self.assertEqual(p.returncode, 1)
            self.assertEqual(out, b'')
            self.assertEqual(err, b'cost_credentials_unavailable\n')
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
            p.stdout.close()
            p.stderr.close()

    def test_rotation_default_is_inert(self):
        out = io.StringIO()
        with patch.object(R.sys, 'argv', ['fixed']), patch.object(R, 'rotate', side_effect=AssertionError('must not execute')), contextlib.redirect_stdout(out):
            self.assertEqual(R.main(), 0)
        self.assertEqual(json.loads(out.getvalue())['operations'], 0)


if __name__ == '__main__':
    unittest.main()
