#!/usr/bin/env python3
"""Read-only, sanitized collection for a frozen audit startup diagnostic SSM batch.

No service actions, network probes, config contents, credential requests or raw logs.
The caller embeds locally computed expectations in the version/hash-pinned document.
"""
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import urllib.request

KINDS = ('credentials', 'writer', 'reader')
ROOTS = ('/opt/clinicaclick-audit', '/etc/clinicaclick-audit', '/var/lib/clinicaclick-audit', '/run/clinicaclick-audit-credentials')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'TZ': 'UTC',
       'AWS_CONFIG_FILE': '/dev/null', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null'}
ENUMS = {
    'LoadState': {'loaded', 'not-found', 'error', 'masked', 'bad-setting'},
    'ActiveState': {'active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'},
    'SubState': {'dead', 'running', 'failed', 'auto-restart', 'start-pre', 'start', 'stop', 'stop-sigterm', 'exited'},
    'Result': {'success', 'exit-code', 'signal', 'core-dump', 'timeout', 'resources', 'start-limit-hit', 'oom-kill', 'dependency', 'protocol'},
    'UnitFileState': {'enabled', 'disabled', 'static', 'masked', 'not-found', 'bad', 'indirect'},
}
NUMBERS = ('ExecMainCode', 'ExecMainStatus', 'NRestarts', 'MainPID', 'ControlPID')
MARKERS = ('AUDIT_ISOLATION_CHECK_FAILED', 'AUDIT_CREDENTIAL_BROKER_START_FAILED', 'AUDIT_WRITER_START_FAILED', 'AUDIT_READER_START_FAILED')


def command(args):
    try:
        proc = subprocess.run(args, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=12)
        return proc.returncode, proc.stdout.decode('utf-8', errors='replace')
    except (OSError, subprocess.TimeoutExpired):
        return -1, ''


def safe_properties(raw):
    result = {}
    for line in raw.splitlines():
        key, sep, value = line.partition('=')
        if not sep:
            continue
        if key in ENUMS:
            result[key] = value if value in ENUMS[key] else 'other_or_unavailable'
        elif key in NUMBERS:
            result[key] = int(value) if re.fullmatch(r'[0-9]{1,9}', value) else None
        elif key == 'ExecStartPre':
            # Never return argv, environment, paths or arbitrary command text.
            codes = re.findall(r'code=(exited|killed|dumped); status=([0-9]{1,3})', value)
            result[key] = [{'code': code, 'status': int(status)} for code, status in codes[:2]]
    return result


def journal_summary(raw):
    counts = Counter()
    records = 0
    for line in raw.splitlines()[:200]:
        try:
            entry = json.loads(line)
        except (ValueError, TypeError):
            counts['unparseable_record'] += 1
            continue
        message = entry.get('MESSAGE', '') if isinstance(entry, dict) else ''
        records += 1
        if not isinstance(message, str):
            counts['unclassified'] += 1
            continue
        tags = [tag for tag in MARKERS if tag in message]
        low = message.lower()
        for word, tag in (
            ('permission denied', 'permission_denied'), ('operation not permitted', 'operation_not_permitted'),
            ('no such file or directory', 'path_missing'), ('cannot find module', 'module_missing'),
            ('out of memory', 'out_of_memory'), ('oom-kill', 'oom_kill'),
            ('dependency failed', 'dependency_failed'), ('start request repeated too quickly', 'start_limit'),
            ('timed out', 'timeout'), ('address already in use', 'address_in_use'),
            ('failed to set up mount namespacing', 'mount_namespace_failed'),
            ('bpf', 'bpf_mentioned'), ('failed with result', 'service_failed'),
        ):
            if word in low:
                tags.append(tag)
        for step in ('NAMESPACE', 'EXEC', 'USER', 'GROUP', 'CHDIR', 'SECCOMP', 'CAPABILITIES', 'CGROUP', 'LIMITS'):
            if 'step ' + step in message or '/' + step in message:
                tags.append('systemd_step_' + step)
        for code in ('EACCES', 'EPERM', 'ENOENT', 'EADDRINUSE', 'ENETUNREACH', 'EAFNOSUPPORT'):
            if re.search(r'\b' + code + r'\b', message):
                tags.append(code)
        for code, number in re.findall(r'code=(exited|killed|dumped), status=([0-9]{1,3})(?:/|\s|$)', message):
            tags.append('process_' + code + '_' + number)
        counts.update(set(tags) or ['unclassified'])
    return {'records': records, 'categories': dict(sorted(counts.items()))}


def metadata(filename):
    path = Path(filename)
    try:
        # Do not traverse even a parent symlink into a different application's files.
        if any(p.is_symlink() for p in (path, *path.parents)):
            return {'state': 'symlink_refused'}
        info = path.lstat()
        kind = 'file' if stat.S_ISREG(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'socket' if stat.S_ISSOCK(info.st_mode) else 'other'
        return {'state': 'present', 'kind': kind, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': oct(stat.S_IMODE(info.st_mode)), 'bytes': info.st_size}
    except FileNotFoundError:
        return {'state': 'missing'}
    except OSError:
        return {'state': 'unavailable'}


def expected_hash(filename, digest):
    # Configs, journals, credentials, PEMs and arbitrary paths are never readable here.
    allowed = (re.fullmatch(r'/opt/clinicaclick-audit/release-69c48195d48d-recovery1/(?:package(?:-lock)?\.json|src/[a-z0-9-]+\.js)', filename)
               or re.fullmatch(r'/etc/systemd/system/clinicaclick-audit-(?:credentials|writer|reader)\.service', filename)
               or filename == '/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin/node')
    if not allowed or not re.fullmatch(r'[0-9a-f]{64}', digest):
        return 'path_or_digest_refused'
    info = metadata(filename)
    if info.get('kind') != 'file' or info['bytes'] > 150000000:
        return info['state'] if info['state'] != 'present' else 'shape_refused'
    try:
        value = hashlib.sha256()
        with open(filename, 'rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                value.update(block)
        return 'match' if value.hexdigest() == digest else 'mismatch'
    except OSError:
        return 'unavailable'


def verify_host():
    if os.getuid() != 0 or os.uname().machine != 'x86_64':
        raise ValueError('host_platform')
    release = Path('/etc/os-release').read_text()
    if 'ID="amzn"' not in release or 'VERSION_ID="2023"' not in release:
        raise ValueError('host_platform')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    token_request = urllib.request.Request('http://169.254.169.254/latest/api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
    # IMDSv2 session token only for instance identity. Never request IAM credentials.
    with opener.open(token_request, timeout=3) as response:
        token = response.read(4096).decode()
    request = urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document', headers={'X-aws-ec2-metadata-token': token})
    with opener.open(request, timeout=3) as response:
        identity = json.loads(response.read(16384))
    if (identity.get('accountId'), identity.get('region'), identity.get('instanceId')) != ('137819318729', 'eu-west-3', 'i-0cf40cfe823f160fa'):
        raise ValueError('host_identity')


def collect(expected):
    services = {}
    for kind in KINDS:
        name = 'clinicaclick-audit-' + kind + '.service'
        properties = ','.join((*ENUMS, *NUMBERS, 'ExecStartPre'))
        code, raw = command(['systemctl', 'show', '--no-pager', '--property=' + properties, name])
        show = {'commandExit': code, 'properties': safe_properties(raw)}
        code, raw = command(['journalctl', '--unit=' + name, '--since=2026-09-14 18:48:00 UTC',
                             '--until=2026-09-14 18:52:00 UTC', '--lines=200', '--output=json', '--no-pager', '--quiet'])
        show['journal'] = {'commandExit': code, **journal_summary(raw)}
        try:
            owner = pwd.getpwnam('cc-audit-' + kind)
            show['identity'] = {'uid': owner.pw_uid, 'gid': owner.pw_gid, 'groups': sorted(os.getgrouplist(owner.pw_name, owner.pw_gid)),
                                'nonLogin': owner.pw_shell == '/sbin/nologin', 'noHome': owner.pw_dir == '/nonexistent'}
        except KeyError:
            show['identity'] = {'state': 'missing'}
        services[kind] = show
    paths = list(ROOTS) + ['/opt/clinicaclick-audit/installation.json',
                          '/opt/clinicaclick-audit/release-69c48195d48d-recovery1',
                          '/opt/clinicaclick-audit/release-69c48195d48d-recovery1/src',
                          '/opt/clinicaclick-audit/node-v24.21.0-recovery1',
                          '/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin',
                          '/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin/node']
    for kind in KINDS:
        paths += ['/etc/systemd/system/clinicaclick-audit-' + kind + '.service']
        paths += ['/etc/clinicaclick-audit/' + kind, '/etc/clinicaclick-audit/' + kind + '/config.json']
        if kind != 'credentials':
            paths += ['/etc/clinicaclick-audit/' + kind + '/tls.' + ext for ext in ('key', 'crt')]
            paths += ['/var/lib/clinicaclick-audit/' + kind, '/run/clinicaclick-audit-credentials/' + kind + '.sock']
    for kind in ('writer', 'reader'):
        paths += ['/var/lib/clinicaclick-audit/' + kind + '/state.sqlite' + suffix for suffix in ('', '-wal', '-shm')]
    _, version = command(['systemctl', '--version'])
    match = re.match(r'systemd ([0-9]{1,4})\b', version)
    _, enforcement = command(['getenforce'])
    return {'status': 'diagnostic_collected_not_repaired', 'instance': 'i-0cf40cfe823f160fa',
            'failedCommandId': '82fb600b-71da-4741-831e-023361c36be1',
            'systemdVersion': int(match[1]) if match else None,
            'cgroupV2': Path('/sys/fs/cgroup/cgroup.controllers').is_file(),
            'selinux': enforcement.strip() if enforcement.strip() in ('Enforcing', 'Permissive', 'Disabled') else 'unavailable',
            'services': services, 'pathMetadata': {p: metadata(p) for p in paths},
            'artifactChecks': {p: expected_hash(p, digest) for p, digest in expected.items()},
            'serviceActions': False, 'ingressChanges': False, 'rawLogsReturned': False,
            'note': 'Broker sockets can be absent after failure cleanup; absence alone does not identify the startup cause.'}


def main(expected):
    try:
        verify_host()
        result = collect(expected)
        encoded = json.dumps(result, sort_keys=True)
        if len(encoded.encode()) > 23000:
            raise ValueError('output_limit')
        print(encoded)
    except Exception:
        print('{"status":"diagnostic_failed","details":"suppressed"}')
        raise SystemExit(1) from None
