#!/usr/bin/env python3
"""Renew local inbox mTLS certificates; never copy keys or call a provider API.

Remote server certificates are a separate enrollment: this executable does not
claim to renew them. Config, signer and timer belong to root, not the CRM user.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import ssl
import stat
import subprocess
import tempfile

UTC = dt.timezone.utc
OPENSSL = '/usr/bin/openssl'
ROLES = {'gateway', 'staging'}


class CertificateError(Exception):
    pass


def command(args, data=None):
    result = subprocess.run([OPENSSL] + args, input=data, capture_output=True, timeout=15)
    if result.returncode:
        raise CertificateError('certificate_command_failed')
    return result.stdout


def private_path(value, root_only=False):
    p = pathlib.Path(value)
    if not p.is_absolute() or p.resolve() != p:
        raise CertificateError('unsafe_certificate_path')
    s = p.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > 65536 or s.st_mode & 0o022:
        raise CertificateError('unsafe_certificate_file')
    if root_only and (s.st_uid != 0 or s.st_mode & 0o077):
        raise CertificateError('unsafe_authority_file')
    return p


def public_key_hash(path, certificate=True):
    if certificate:
        pem = command(['x509', '-in', str(path), '-pubkey', '-noout'])
        der = command(['pkey', '-pubin', '-outform', 'DER'], pem)
    else:
        der = command(['pkey', '-in', str(path), '-pubout', '-outform', 'DER'])
    return hashlib.sha256(der).hexdigest()


def expires(path):
    raw = command(['x509', '-in', str(path), '-noout', '-enddate']).decode().strip().split('=', 1)[1]
    return dt.datetime.strptime(raw, '%b %d %H:%M:%S %Y GMT').replace(tzinfo=UTC)


def certificate_hash(path):
    return hashlib.sha256(command(['x509', '-in', str(path), '-outform', 'DER'])).hexdigest()


def validate_certificate(path, identity, ca):
    # OpenSSL verifies validity, chain and client purpose. Key and subject pins
    # then constrain that certificate to this exact locally configured role.
    command(['verify', '-purpose', 'sslclient', '-CAfile', str(ca), str(path)])
    if public_key_hash(path) != identity['publicKeySha256']:
        raise CertificateError('certificate_identity_changed')
    subject = command(['x509', '-in', str(path), '-noout', '-subject', '-nameopt', 'RFC2253']).decode().strip()
    if subject != 'subject=CN=' + identity['commonName']:
        raise CertificateError('certificate_subject_changed')


def probe(identity, cert, key, ca):
    # This deliberately invalid route exercises TLS + exact role recognition.
    # scope_denied is not success. No inbox payload, Meta or clinical data read.
    context = ssl.create_default_context(cafile=str(ca))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(cert), str(key))
    connection = http.client.HTTPSConnection('13.39.100.55', 8445, context=context, timeout=8)
    try:
        connection.request('GET', '/healthz')
        response = connection.getresponse()
        body = response.read(2048)
        if response.status != 403 or json.loads(body) != {'error': {'code': 'operation_denied'}}:
            raise CertificateError('renewed_identity_not_accepted')
    finally:
        connection.close()


def atomic_write(path, content, mode=0o600, uid=0, gid=0):
    path = pathlib.Path(path)
    fd, temp = tempfile.mkstemp(prefix='.certificate-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
        directory = os.open(str(path.parent), os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def renew(identity, authority, state_dir, force=False, now=None, verify_remote=probe):
    now = now or dt.datetime.now(UTC)
    cert = private_path(identity['certificateFile'])
    key = private_path(identity['privateKeyFile'])
    ca = private_path(authority['certificateFile'])
    ca_key = private_path(authority['privateKeyFile'], root_only=True)
    if certificate_hash(ca) != authority['certificateSha256'] or public_key_hash(ca) != public_key_hash(ca_key, False):
        raise CertificateError('authority_identity_changed')
    if public_key_hash(key, False) != identity['publicKeySha256']:
        raise CertificateError('private_key_changed')
    before = cert.read_bytes()
    if not force and expires(cert) > now + dt.timedelta(days=10):
        validate_certificate(cert, identity, ca)
        verify_remote(identity, cert, key, ca)
        return {'id': identity['id'], 'status': 'healthy', 'expiresAt': expires(cert).isoformat()}
    if expires(ca) < now + dt.timedelta(days=31):
        raise CertificateError('authority_expiring')
    with tempfile.TemporaryDirectory(prefix='issue-', dir=str(state_dir)) as directory:
        csr = pathlib.Path(directory) / 'request.csr'
        candidate = pathlib.Path(directory) / 'candidate.crt'
        extensions = pathlib.Path(directory) / 'extensions.cnf'
        extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n')
        command(['req', '-new', '-key', str(key), '-out', str(csr), '-subj', '/CN=' + identity['commonName']])
        command(['req', '-in', str(csr), '-verify', '-noout'])
        # Random serial: no shared CA serial file or race with another issuer.
        command(['x509', '-req', '-in', str(csr), '-CA', str(ca), '-CAkey', str(ca_key),
                 '-set_serial', '0x' + os.urandom(16).hex(), '-days', '30', '-sha256',
                 '-extfile', str(extensions), '-out', str(candidate)])
        os.chmod(candidate, 0o600)
        validate_certificate(candidate, identity, ca)
        verify_remote(identity, candidate, key, ca)  # Acceptance BEFORE publication.
        info = cert.stat()
        if cert.read_bytes() != before:
            raise CertificateError('concurrent_certificate_change')
        backup = pathlib.Path(state_dir) / (identity['id'] + '-' + certificate_hash(cert) + '.crt')
        if not backup.exists():
            atomic_write(backup, before)
        atomic_write(cert, candidate.read_bytes(), stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        try:
            validate_certificate(cert, identity, ca)
            verify_remote(identity, cert, key, ca)
        except Exception:
            atomic_write(cert, before, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
            raise CertificateError('renewal_rolled_back')
    return {'id': identity['id'], 'status': 'renewed', 'expiresAt': expires(cert).isoformat()}


def validate_config(config):
    if set(config) != {'version', 'authority', 'identities', 'stateDirectory', 'statusFile', 'statusGroupId'} or config['version'] != 1:
        raise CertificateError('configuration_invalid')
    authority = config['authority']
    if set(authority) != {'certificateFile', 'privateKeyFile', 'certificateSha256'} or not re.fullmatch('[a-f0-9]{64}', authority['certificateSha256']):
        raise CertificateError('configuration_invalid')
    if len(config['identities']) != 2 or {x['id'] for x in config['identities']} != ROLES:
        raise CertificateError('configuration_invalid')
    for item in config['identities']:
        if set(item) != {'id', 'certificateFile', 'privateKeyFile', 'commonName', 'publicKeySha256'}:
            raise CertificateError('configuration_invalid')
        if item['commonName'] != 'clinicaclick-' + item['id'] + '-whatsapp-inbox' or not re.fullmatch('[a-f0-9]{64}', item['publicKeySha256']):
            raise CertificateError('configuration_invalid')
        prefix = '/etc/clinicaclick-whatsapp-inbox/' + item['id'] + '/'
        if item['certificateFile'] != prefix + 'client.crt' or item['privateKeyFile'] != prefix + 'client.key':
            raise CertificateError('configuration_invalid')
    if not isinstance(config['statusGroupId'], int) or config['statusGroupId'] < 0:
        raise CertificateError('configuration_invalid')
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--force-role', choices=sorted(ROLES))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise CertificateError('root_required')
    config = validate_config(json.loads(private_path(args.config, root_only=True).read_bytes()))
    state_dir = pathlib.Path(config['stateDirectory'])
    if not state_dir.is_absolute() or state_dir.resolve() != state_dir:
        raise CertificateError('unsafe_state_directory')
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_dir.stat().st_uid != 0 or stat.S_IMODE(state_dir.stat().st_mode) != 0o700:
        raise CertificateError('unsafe_state_directory')
    with (state_dir / 'renew.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        results = []
        for identity in config['identities']:
            try:
                results.append(renew(identity, config['authority'], state_dir, force=args.force_role == identity['id']))
            except Exception as error:
                code = str(error) if isinstance(error, CertificateError) else 'certificate_check_failed'
                results.append({'id': identity['id'], 'status': 'failed', 'reason': code})
        result = {'version': 1, 'checkedAt': dt.datetime.now(UTC).isoformat(), 'certificates': results}
        atomic_write(pathlib.Path(config['statusFile']), json.dumps(result).encode(), 0o640, 0, config['statusGroupId'])
        print(json.dumps(result))  # Fixed metadata only; no CSR, key, payload or provider credential.
        return int(any(item['status'] == 'failed' for item in results))


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error) if isinstance(error, CertificateError) else 'certificate_maintenance_failed'}))
        raise SystemExit(1)
