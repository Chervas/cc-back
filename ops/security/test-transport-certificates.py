#!/usr/bin/env python3
"""Synthetic local CA tests. No AWS, Meta, network or application database."""
import importlib.util
import pathlib
import tempfile
import unittest
import os
import datetime as dt

spec = importlib.util.spec_from_file_location('renewal', pathlib.Path(__file__).with_name('transport-certificates.py'))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class RenewalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cc-cert-qa-')
        self.addCleanup(self.tmp.cleanup)
        self.p = pathlib.Path(self.tmp.name)
        (self.p / 'ca.cnf').write_text('[req]\ndistinguished_name=dn\n[dn]\n')
        R.command(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                   '-config', str(self.p / 'ca.cnf'), '-keyout', str(self.p / 'ca.key'), '-out', str(self.p / 'ca.crt'),
                   '-days', '365', '-subj', '/CN=FICTITIOUS_CA', '-addext', 'basicConstraints=critical,CA:TRUE'])
        os.chmod(self.p / 'ca.key', 0o600)
        self.authority = {'certificateFile': str(self.p / 'ca.crt'), 'privateKeyFile': str(self.p / 'ca.key'),
                          'certificateSha256': R.certificate_hash(self.p / 'ca.crt')}
        self.identity = {'id': 'gateway', 'commonName': 'clinicaclick-gateway-whatsapp-inbox',
                         'certificateFile': str(self.p / 'client.crt'), 'privateKeyFile': str(self.p / 'client.key')}
        R.command(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                   '-keyout', str(self.p / 'client.key'), '-out', str(self.p / 'client.csr'), '-subj', '/CN=' + self.identity['commonName']])
        os.chmod(self.p / 'client.key', 0o600)
        (self.p / 'extensions').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n')
        R.command(['x509', '-req', '-in', str(self.p / 'client.csr'), '-CA', str(self.p / 'ca.crt'),
                   '-CAkey', str(self.p / 'ca.key'), '-set_serial', '10', '-days', '20', '-extfile', str(self.p / 'extensions'),
                   '-out', str(self.p / 'client.crt')])
        os.chmod(self.p / 'client.crt', 0o600)
        self.identity['publicKeySha256'] = R.public_key_hash(self.p / 'client.crt')
        self.before = (self.p / 'client.crt').read_bytes()
        self.key_before = (self.p / 'client.key').read_bytes()
        self.calls = []

    def check(self, identity, cert, key, ca):
        R.validate_certificate(cert, identity, ca)
        self.calls.append(str(cert))

    def test_renew_preserves_key_and_ownership_probes_before_after_and_keeps_backup(self):
        result = R.renew(self.identity, self.authority, self.p, force=True, verify_remote=self.check)
        self.assertEqual(result['status'], 'renewed')
        self.assertEqual(len(self.calls), 2)
        self.assertNotEqual((self.p / 'client.crt').read_bytes(), self.before)
        self.assertEqual((self.p / 'client.key').read_bytes(), self.key_before)
        self.assertEqual(os.stat(self.p / 'client.crt').st_mode & 0o777, 0o600)
        self.assertEqual(next(self.p.glob('gateway-*.crt')).read_bytes(), self.before)

    def test_fresh_certificate_is_checked_but_not_renewed(self):
        result = R.renew(self.identity, self.authority, self.p, verify_remote=self.check)
        self.assertEqual(result['status'], 'healthy')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual((self.p / 'client.crt').read_bytes(), self.before)

    def test_failed_acceptance_does_not_replace_live_certificate(self):
        def reject(*args):
            raise R.CertificateError('renewed_identity_not_accepted')
        with self.assertRaisesRegex(R.CertificateError, 'renewed_identity_not_accepted'):
            R.renew(self.identity, self.authority, self.p, force=True, verify_remote=reject)
        self.assertEqual((self.p / 'client.crt').read_bytes(), self.before)

    def test_failed_post_install_probe_restores_previous_certificate(self):
        def reject_second(*args):
            self.check(*args)
            if len(self.calls) == 2:
                raise R.CertificateError('renewed_identity_not_accepted')
        with self.assertRaisesRegex(R.CertificateError, 'renewal_rolled_back'):
            R.renew(self.identity, self.authority, self.p, force=True, verify_remote=reject_second)
        self.assertEqual((self.p / 'client.crt').read_bytes(), self.before)

    def test_concurrent_change_is_preserved(self):
        def changed(*args):
            self.check(*args)
            (self.p / 'client.crt').write_bytes(self.before + b'\n')
        with self.assertRaisesRegex(R.CertificateError, 'concurrent_certificate_change'):
            R.renew(self.identity, self.authority, self.p, force=True, verify_remote=changed)
        self.assertEqual((self.p / 'client.crt').read_bytes(), self.before + b'\n')

    def test_changed_authority_and_almost_expired_authority_are_rejected(self):
        bad = dict(self.authority, certificateSha256='0' * 64)
        with self.assertRaisesRegex(R.CertificateError, 'authority_identity_changed'):
            R.renew(self.identity, bad, self.p, force=True, verify_remote=self.check)
        with self.assertRaisesRegex(R.CertificateError, 'authority_expiring'):
            R.renew(self.identity, self.authority, self.p, force=True, verify_remote=self.check,
                    now=dt.datetime.now(R.UTC) + dt.timedelta(days=350))
        self.assertEqual(self.calls, [])

    def test_wrong_key_and_symlink_are_rejected(self):
        bad = dict(self.identity, publicKeySha256='0' * 64)
        with self.assertRaisesRegex(R.CertificateError, 'private_key_changed'):
            R.renew(bad, self.authority, self.p, force=True, verify_remote=self.check)
        (self.p / 'linked.crt').symlink_to(self.p / 'client.crt')
        with self.assertRaisesRegex(R.CertificateError, 'unsafe_certificate_path'):
            R.renew(dict(self.identity, certificateFile=str(self.p / 'linked.crt')), self.authority, self.p, force=True, verify_remote=self.check)


if __name__ == '__main__':
    unittest.main()
