#!/usr/bin/python3
"""Fixed Roles Anywhere credential_process. Stdout is credentials for the SDK only."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys

BASE = Path('/etc/clinicaclick-costs')
CONFIG = BASE / 'roles-anywhere.json'
IDENTITIES = BASE / 'identities'
CURRENT = BASE / 'current'
SELF = Path('/usr/local/libexec/clinicaclick-cost-credentials')
HELPER = Path('/usr/local/libexec/aws_signing_helper-1.8.5')
HELPER_SHA256 = 'beec9ed1c492d93db809890f16713e3556353294b823c2184ad4e891f1b2b54d'
LIBRARY = Path('/opt/clinicaclick-cost-credential-runtime/aws-helper-1.8.5')
LOADER = LIBRARY / 'ld-linux-x86-64.so.2'
LOADER_SHA256 = '8d06f393f4a93bcf9b81145a259524d66a95522a646bf8d7e05b6ffdf2e63dcc'
LIBC_SHA256 = 'e01b1ce7be2987f3b8560e26d0df2623f9dd5cec17be923ae28a785bc0d32d50'
RESOLV_SHA256 = 'c0724375581c0303a3ea8bcf1d5cfce6b63eca7b99313c6598a721b414634751'
ROLE = 'arn:aws:iam::137819318729:role/clinicaclick-platform-cost-collector-role'
CN = 'clinicaclick-platform-cost-collector'
ISSUER = 'clinicaclick-platform-costs-root-20261024'
REGION = 'eu-west-3'
SESSION_SECONDS = 900
CHILD_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'HOME': '/nonexistent'}
ARN = re.compile(r'^arn:aws:rolesanywhere:eu-west-3:137819318729:(trust-anchor|profile)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def require(value):
    if not value:
        raise ValueError('cost_credentials_unavailable')


def directories(p):
    """Every canonical parent is root owned and not writable by other identities."""
    p = Path(p)
    require(p.is_absolute() and p.resolve(strict=True) == p)
    for q in [p] + list(p.parents):
        s = q.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022)


def open_checked(p, mode, gid=None, max_bytes=16384):
    p = Path(p)
    directories(p.parent)
    s = p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == mode
            and s.st_nlink == 1 and 0 < s.st_size <= max_bytes and (gid is None or s.st_gid == gid))
    fd = os.open(str(p), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        z = os.fstat(fd)
        require((z.st_dev, z.st_ino, z.st_size, z.st_mode, z.st_uid, z.st_gid, z.st_nlink)
                == (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_uid, s.st_gid, s.st_nlink))
        return fd
    except BaseException:
        os.close(fd)
        raise


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out)
        out[key] = value
    return out


def read_config():
    fd = open_checked(CONFIG, 0o644, max_bytes=4096)
    try:
        raw = os.read(fd, 4097)
        require(len(raw) <= 4096)
        value = json.loads(raw, object_pairs_hook=unique_object)
    finally:
        os.close(fd)
    require(set(value) == {'schema', 'trustAnchorArn', 'profileArn', 'roleArn', 'region', 'durationSeconds'})
    require(value['schema'] == 'clinicaclick-cost-roles-anywhere/1' and value['roleArn'] == ROLE
            and value['region'] == REGION and type(value['durationSeconds']) is int
            and value['durationSeconds'] == SESSION_SECONDS)
    for field, kind in [('trustAnchorArn', 'trust-anchor'), ('profileArn', 'profile')]:
        match = ARN.fullmatch(value[field]) if isinstance(value[field], str) else None
        require(match is not None and match.group(1) == kind)
    return value


def open_identity():
    directories(BASE)
    directories(IDENTITIES)
    link = CURRENT.lstat()
    require(stat.S_ISLNK(link.st_mode) and link.st_uid == 0 and link.st_nlink == 1)
    target = os.readlink(CURRENT)  # Resolve the current identity exactly once.
    require('..' not in Path(target).parts)
    resolved = (BASE / target).resolve(strict=True) if not os.path.isabs(target) else Path(target).resolve(strict=True)
    require(resolved.parent == IDENTITIES and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', resolved.name))
    directories(resolved)
    d = resolved.lstat()
    require(stat.S_IMODE(d.st_mode) == 0o750 and d.st_gid == 1000)
    cert_fd = open_checked(resolved / 'leaf.pem', 0o444, gid=1000)
    try:
        key_fd = open_checked(resolved / 'leaf.key', 0o440, gid=1000, max_bytes=8192)
    except BaseException:
        os.close(cert_fd)
        raise
    return resolved.name, cert_fd, key_fd


def certificate_info(cert_fd, run=subprocess.run):
    result = run(['/usr/bin/openssl', 'x509', '-in', '/proc/self/fd/' + str(cert_fd), '-noout',
                  '-subject', '-issuer', '-dates', '-nameopt', 'RFC2253'],
                 pass_fds=(cert_fd,), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                 stderr=subprocess.PIPE, timeout=2, env=CHILD_ENV, check=False)
    require(result.returncode == 0 and not result.stderr and len(result.stdout) <= 4096)
    rows = result.stdout.decode('ascii').strip().splitlines()
    require(len(rows) == 4)
    values = dict(row.split('=', 1) for row in rows)
    require(set(values) == {'subject', 'issuer', 'notBefore', 'notAfter'}
            and values['subject'] == 'CN=' + CN and values['issuer'] == 'CN=' + ISSUER)
    fmt = '%b %d %H:%M:%S %Y %Z'
    before = dt.datetime.strptime(values['notBefore'], fmt).replace(tzinfo=dt.timezone.utc)
    after = dt.datetime.strptime(values['notAfter'], fmt).replace(tzinfo=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    require(before <= now + dt.timedelta(seconds=60) and after > now + dt.timedelta(minutes=20))
    return {'notBefore': before, 'notAfter': after}


def pinned_runtime():
    # Versioned Root-installed closure; no dependency on Snap paths or revisions.
    directories(LIBRARY)
    for p, digest, bound in [(HELPER, HELPER_SHA256, 32 * 1024 * 1024),
                             (LOADER, LOADER_SHA256, 4 * 1024 * 1024),
                             (LIBRARY / 'libc.so.6', LIBC_SHA256, 4 * 1024 * 1024),
                             (LIBRARY / 'libresolv.so.2', RESOLV_SHA256, 1024 * 1024)]:
        directories(p.parent)
        s = p.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022
                and s.st_nlink == 1 and 0 < s.st_size <= bound and p.resolve(strict=True) == p)
        fd = os.open(str(p), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            z = os.fstat(fd)
            require((z.st_dev, z.st_ino, z.st_size) == (s.st_dev, s.st_ino, s.st_size))
            h = hashlib.sha256()
            while True:
                chunk = os.read(fd, 131072)
                if not chunk:
                    break
                h.update(chunk)
            require(h.hexdigest() == digest)
        finally:
            os.close(fd)


def validate_credentials(raw, now=None):
    require(isinstance(raw, bytes) and len(raw) <= 16384)
    value = json.loads(raw, object_pairs_hook=unique_object)
    require(type(value.get('Version')) is int and value['Version'] == 1
            and set(value) == {'Version', 'AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration'})
    require(isinstance(value['AccessKeyId'], str) and re.fullmatch(r'ASIA[A-Z0-9]{16}', value['AccessKeyId']))
    require(isinstance(value['SecretAccessKey'], str) and re.fullmatch(r'[A-Za-z0-9/+=]{40}', value['SecretAccessKey']))
    require(isinstance(value['SessionToken'], str) and re.fullmatch(r'[!-~]{16,8192}', value['SessionToken']))
    require(isinstance(value['Expiration'], str) and value['Expiration'].endswith('Z'))
    expiry = dt.datetime.fromisoformat(value['Expiration'][:-1] + '+00:00')
    now = now or dt.datetime.now(dt.timezone.utc)
    ttl = (expiry - now).total_seconds()
    require(600 <= ttl <= min(3600, SESSION_SECONDS + 120))
    return value


def credentials(run=subprocess.run):
    require(os.getuid() == os.geteuid() == 1000)
    own = SELF.lstat()
    require(stat.S_ISREG(own.st_mode) and own.st_uid == 0 and stat.S_IMODE(own.st_mode) == 0o755
            and own.st_nlink == 1 and SELF.resolve(strict=True) == SELF)
    directories(SELF.parent)
    cfg = read_config()
    pinned_runtime()
    _version, cert_fd, key_fd = open_identity()
    try:
        certificate_info(cert_fd, run)
        args = [str(LOADER), '--inhibit-cache', '--library-path', str(LIBRARY), str(HELPER), 'credential-process',
                '--certificate', '/proc/self/fd/' + str(cert_fd), '--private-key', '/proc/self/fd/' + str(key_fd),
                '--trust-anchor-arn', cfg['trustAnchorArn'], '--profile-arn', cfg['profileArn'],
                '--role-arn', ROLE, '--region', REGION, '--session-duration', str(SESSION_SECONDS)]
        result = run(args, pass_fds=(cert_fd, key_fd), stdin=subprocess.DEVNULL,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5,
                     env=CHILD_ENV, check=False)
        require(result.returncode == 0 and not result.stderr)
        return validate_credentials(result.stdout)
    finally:
        os.close(cert_fd)
        os.close(key_fd)


def interrupted(_signum, _frame):
    # subprocess.run kills and waits for its owned child on an exception.
    raise RuntimeError('cost_credentials_unavailable')


def main():
    signal.signal(signal.SIGTERM, interrupted)
    try:
        require(len(sys.argv) == 1)
        value = credentials()
        sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
        return 0
    except Exception:
        # Never echo helper stderr, credentials, config, certificate or paths.
        sys.stderr.write('cost_credentials_unavailable\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
