#!/usr/bin/python3
"""Local-only purpose PKI rotation. No AWS, provider, network or credential output."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys

BASE = Path('/etc/clinicaclick-costs')
AUTHORITY = BASE / 'authority'
IDENTITIES = BASE / 'identities'
CURRENT = BASE / 'current'
CN = 'clinicaclick-platform-cost-collector'
ISSUER = 'clinicaclick-platform-costs-root-20261024'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'HOME': '/nonexistent'}
EXTENSIONS = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n'


def require(value):
    if not value:
        raise ValueError('cost_certificate_rotation_unavailable')


def directory(p):
    p = Path(p)
    require(p.resolve(strict=True) == p)
    for q in [p] + list(p.parents):
        s = q.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)


def syncdir(p):
    fd = os.open(str(p), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def run(args, fds=(), execute=subprocess.run):
    x = execute(['/usr/bin/openssl'] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, pass_fds=fds, timeout=20, env=ENV, check=False)
    require(x.returncode == 0 and len(x.stdout) <= 16384)
    return x.stdout


def rootfile(p, mode, maximum):
    s = p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == mode
            and s.st_nlink == 1 and 0 < s.st_size <= maximum)
    fd = os.open(str(p), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        z = os.fstat(fd)
        require((z.st_dev, z.st_ino, z.st_size, z.st_mode, z.st_uid, z.st_gid, z.st_nlink)
                == (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_uid, s.st_gid, s.st_nlink))
        return fd
    except BaseException:
        os.close(fd)
        raise


def current_state():
    if not os.path.lexists(CURRENT):
        return None
    s = CURRENT.lstat()
    require(stat.S_ISLNK(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1)
    text = os.readlink(CURRENT)
    target = (BASE / text).resolve(strict=True) if not os.path.isabs(text) else Path(text).resolve(strict=True)
    require('..' not in Path(text).parts and target.parent == IDENTITIES
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', target.name))
    directory(target)
    d = target.lstat()
    require(stat.S_IMODE(d.st_mode) == 0o750 and d.st_gid == 1000)
    for name, mode, bound in [('leaf.pem', 0o444, 16384), ('leaf.key', 0o440, 8192)]:
        s = (target / name).lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_gid == 1000 and s.st_nlink == 1
                and stat.S_IMODE(s.st_mode) == mode and 0 < s.st_size <= bound)
    return (s.st_dev, s.st_ino, text, target)


def check_leaf(cert, ca_fd, expected_days=None):
    run(['verify', '-CAfile', '/proc/self/fd/' + str(ca_fd), str(cert)], (ca_fd,))
    data = run(['x509', '-in', str(cert), '-noout', '-subject', '-issuer', '-dates', '-nameopt', 'RFC2253']).decode('ascii')
    vals = dict(row.split('=', 1) for row in data.strip().splitlines())
    require(vals['subject'] == 'CN=' + CN and vals['issuer'] == 'CN=' + ISSUER)
    fmt = '%b %d %H:%M:%S %Y %Z'
    expiry = dt.datetime.strptime(vals['notAfter'], fmt).replace(tzinfo=dt.timezone.utc)
    text = run(['x509', '-in', str(cert), '-noout', '-text']).decode('ascii')
    require('CA:FALSE' in text and 'Digital Signature' in text and 'TLS Web Client Authentication' in text
            and 'sha256' in text.lower())
    if expected_days is not None:
        ttl = (expiry - dt.datetime.now(dt.timezone.utc)).total_seconds()
        require((expected_days - 1) * 86400 < ttl <= (expected_days + 1) * 86400)
    return expiry


def rotate():
    require(os.getuid() == os.geteuid() == 0)
    os.umask(0o077)
    directory(BASE)
    directory(AUTHORITY)
    if not IDENTITIES.exists():
        IDENTITIES.mkdir(mode=0o750)
        os.chown(IDENTITIES, 0, 1000)
        os.chmod(IDENTITIES, 0o750)  # mkdir's requested mode is reduced by our 0077 umask.
    directory(IDENTITIES)
    identity_stat = IDENTITIES.lstat()
    require(identity_stat.st_uid == 0 and identity_stat.st_gid == 1000
            and stat.S_IMODE(identity_stat.st_mode) == 0o750)
    lock = os.open(str(BASE / 'rotation.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    lockstat = os.fstat(lock)
    require(stat.S_ISREG(lockstat.st_mode) and lockstat.st_uid == 0 and lockstat.st_nlink == 1
            and stat.S_IMODE(lockstat.st_mode) == 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ca_fd = rootfile(AUTHORITY / 'ca.pem', 0o600, 16384)
        try:
            ca_key_fd = rootfile(AUTHORITY / 'ca-key.pem', 0o600, 8192)
            try:
                prior = current_state()
                if prior is not None:
                    expiry = check_leaf(prior[3] / 'leaf.pem', ca_fd)
                    require(run(['pkey', '-in', str(prior[3] / 'leaf.key'), '-pubout'])
                            == run(['x509', '-in', str(prior[3] / 'leaf.pem'), '-pubkey', '-noout']))
                    if expiry > dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7):
                        return {'status': 'CURRENT_PURPOSE_CERTIFICATE_VALID_NO_ROTATION', 'rotated': False}
                version = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(8)
                temporary = IDENTITIES / ('.pending-' + version)
                target = IDENTITIES / version
                temporary.mkdir(mode=0o700)
                promoted = False
                try:
                    ext = temporary / 'extensions.cnf'
                    ext.write_text(EXTENSIONS)
                    request_config = temporary / 'request.cnf'
                    request_config.write_text('[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=' + CN + '\n')
                    run(['req', '-new', '-config', str(request_config), '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                         '-keyout', str(temporary / 'leaf.key'), '-out', str(temporary / 'leaf.csr'), '-subj', '/CN=' + CN])
                    run(['x509', '-req', '-in', str(temporary / 'leaf.csr'), '-CA', '/proc/self/fd/' + str(ca_fd),
                         '-CAkey', '/proc/self/fd/' + str(ca_key_fd), '-set_serial', '0x' + secrets.token_hex(16),
                         '-days', '30', '-sha256', '-extfile', str(ext), '-out', str(temporary / 'leaf.pem')],
                        (ca_fd, ca_key_fd))
                    expiry = check_leaf(temporary / 'leaf.pem', ca_fd, 30)
                    pubkey = run(['pkey', '-in', str(temporary / 'leaf.key'), '-pubout'])
                    require(pubkey == run(['x509', '-in', str(temporary / 'leaf.pem'), '-pubkey', '-noout']))
                    for name, mode in [('leaf.key', 0o440), ('leaf.pem', 0o444)]:
                        p = temporary / name
                        os.chown(p, 0, 1000)
                        os.chmod(p, mode)
                        fd = os.open(str(p), os.O_RDONLY | os.O_NOFOLLOW)
                        try:
                            os.fsync(fd)
                        finally:
                            os.close(fd)
                    (temporary / 'leaf.csr').unlink()
                    ext.unlink()
                    request_config.unlink()
                    os.chown(temporary, 0, 1000)
                    os.chmod(temporary, 0o750)
                    syncdir(temporary)
                    os.rename(temporary, target)
                    promoted = True
                    syncdir(IDENTITIES)
                    require(current_state() == prior)
                    next_link = BASE / ('.current-' + secrets.token_hex(8))
                    os.symlink('identities/' + version, next_link)
                    try:
                        require(current_state() == prior)
                        os.replace(next_link, CURRENT)
                        syncdir(BASE)
                    finally:
                        if os.path.lexists(next_link):
                            next_link.unlink()
                    return {'status': 'NEW_PURPOSE_CERTIFICATE_ATOMICALLY_ACTIVATED', 'rotated': True,
                            'identityVersion': version, 'notAfter': expiry.isoformat()}
                finally:
                    if not promoted and temporary.exists():
                        shutil.rmtree(temporary)
            finally:
                os.close(ca_key_fd)
        finally:
            os.close(ca_fd)
    finally:
        os.close(lock)


def main():
    if sys.argv[1:] != ['--rotate-if-needed']:
        if len(sys.argv) == 1:
            print('{"status":"INERT_LOCAL_COST_CERTIFICATE_ROTATOR","operations":0}')
            return 0
        sys.stderr.write('cost_certificate_rotation_unavailable\n')
        return 1
    try:
        print(json.dumps(rotate(), separators=(',', ':')))
        return 0
    except Exception:
        sys.stderr.write('cost_certificate_rotation_unavailable\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
