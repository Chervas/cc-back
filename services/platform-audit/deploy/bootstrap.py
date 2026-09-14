#!/usr/bin/env python3
"""One-time AL2023 audit installation. Executed only through a reviewed, frozen SSM document."""
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

INSTANCE = 'i-0cf40cfe823f160fa'
ACCOUNT = '137819318729'
ROLE = 'arn:aws:iam::137819318729:role/clinicaclick-integrations-prod-ec2-role'
IP = '13.39.100.55'
NODE_VERSION = '24.21.0'
NODE_SHA = 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'
BASE = Path('/opt/clinicaclick-audit')
CONFIG = Path('/etc/clinicaclick-audit')
STATE = Path('/var/lib/clinicaclick-audit')
USERS = {'credentials': 'cc-audit-credentials', 'writer': 'cc-audit-writer', 'reader': 'cc-audit-reader'}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'AWS_CONFIG_FILE': '/dev/null', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null'}
STEP = 'validate_input'


def run(args, **kwargs):
    return subprocess.run([str(s) for s in args], env=ENV, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=kwargs.pop('timeout', 60), **kwargs).stdout


def bundle_files(filename, digest):
    raw = Path(filename).read_bytes()
    if len(digest) != 64 or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('artifact_hash')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:
        for entry in tar:
            parts = Path(entry.name).parts
            allowed = entry.name in ('package.json', 'package-lock.json') or (len(parts) == 2 and parts[0] == 'src' and parts[1].endswith('.js'))
            if not allowed or not entry.isfile() or entry.name in files or entry.size > 200000 or len(files) >= 80:
                raise ValueError('artifact_member')
            files[entry.name] = tar.extractfile(entry).read()
    if len(files) < 10 or sum(map(len, files.values())) > 1000000:
        raise ValueError('artifact_shape')
    return files


def preflight():
    if os.getuid() != 0 or os.uname().machine != 'x86_64':
        raise ValueError('host_platform')
    release = Path('/etc/os-release').read_text()
    if 'ID="amzn"' not in release or 'VERSION_ID="2023"' not in release:
        raise ValueError('host_release')
    for root in (BASE, CONFIG, STATE):
        if root.exists() or root.is_symlink():
            raise ValueError('existing_installation')
    for user in USERS.values():
        try:
            pwd.getpwnam(user)
        except KeyError:
            pass
        else:
            raise ValueError('existing_service_user')
    for name in USERS:
        if run(['systemctl', 'show', '-p', 'LoadState', '--value', 'clinicaclick-audit-' + name + '.service']).strip() != b'not-found':
            raise ValueError('existing_service')
    for binary in ['openssl', 'tar', 'useradd', 'usermod', 'runuser', 'systemctl', 'systemd-analyze']:
        if not shutil.which(binary, path=ENV['PATH']):
            raise ValueError('host_tool')
    if shutil.disk_usage('/opt').free < 1500000000:
        raise ValueError('disk_space')
    for port in (8443, 8444):
        with socket.socket() as s:
            s.bind(('0.0.0.0', port))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request('http://169.254.169.254/latest/api/token', method='PUT', headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
    token = opener.open(req, timeout=3).read().decode()
    req = urllib.request.Request('http://169.254.169.254/latest/dynamic/instance-identity/document', headers={'X-aws-ec2-metadata-token': token})
    metadata = json.loads(opener.open(req, timeout=3).read())
    if metadata.get('accountId') != ACCOUNT or metadata.get('instanceId') != INSTANCE or metadata.get('region') != 'eu-west-3':
        raise ValueError('host_identity')


def private_write(filename, value, owner):
    filename.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(filename, 0o600)
    os.chown(filename, owner.pw_uid, owner.pw_gid)


def unit(kind, release, node):
    common = f'''[Unit]
Description=ClinicaClick audit {kind}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=3
'''
    if kind != 'credentials':
        common += 'Requires=clinicaclick-audit-credentials.service\nAfter=clinicaclick-audit-credentials.service\n'
    common += f'''[Service]
Type=simple
User={USERS[kind]}
Group={USERS[kind]}
UMask=0077
WorkingDirectory={release}
Environment=AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_V1_DISABLED=true
Environment=AWS_EC2_METADATA_SERVICE_ENDPOINT=http://169.254.169.254
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
TasksMax=64
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
StandardOutput=null
StandardError=journal
'''
    if kind == 'credentials':
        common += f'''SupplementaryGroups={USERS['writer']} {USERS['reader']}
RuntimeDirectory=clinicaclick-audit-credentials
RuntimeDirectoryMode=0711
Environment=AWS_EC2_METADATA_DISABLED=false
MemoryMax=192M
InaccessiblePaths={CONFIG}/writer {CONFIG}/reader {STATE}
ExecStart={node} --max-old-space-size=96 {release}/src/credential-broker.js {CONFIG}/credentials/config.json
'''
    else:
        other = 'reader' if kind == 'writer' else 'writer'
        main = 'writer-https-main.js' if kind == 'writer' else 'reader-main.js'
        common += f'''Environment=AWS_EC2_METADATA_DISABLED=true
IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128
ReadWritePaths={STATE}/{kind}
InaccessiblePaths={CONFIG}/credentials {CONFIG}/{other} {STATE}/{other}
MemoryMax={'512M' if kind == 'writer' else '384M'}
ExecStartPre={node} {release}/src/verify-isolation.js {kind}
ExecStart={node} --max-old-space-size={'192' if kind == 'writer' else '128'} {release}/src/{main} {CONFIG}/{kind}/config.json
'''
    return common + '\n[Install]\nWantedBy=multi-user.target\n'


def install(artifact, digest, principals_file):
    global STEP
    files = bundle_files(artifact, digest)
    principals = json.loads(Path(principals_file).read_text())
    if set(principals) != {'writer', 'confirmed', 'reconcile'} or len({p['publicKey'] for p in principals.values()}) != 3:
        raise ValueError('public_principals')
    for purpose, principal in principals.items():
        if set(principal) != {'keyId', 'publicKey'} or principal['keyId'] != 'staging-' + purpose + '-v1' or 'PRIVATE' in principal['publicKey']:
            raise ValueError('public_principals')
        details = run(['openssl', 'pkey', '-pubin', '-text', '-noout'], input=principal['publicKey'].encode())
        if b'ED25519' not in details:
            raise ValueError('public_key_type')
    STEP = 'preflight'; preflight()
    os.umask(0o022)
    started = []
    with tempfile.TemporaryDirectory(prefix='clinicaclick-audit-bootstrap-') as tmp:
        STEP = 'download_verified_node'
        tmp = Path(tmp)
        archive = tmp / 'node.tar.xz'
        url = f'https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz'
        with urllib.request.urlopen(url, timeout=120) as src, archive.open('wb') as dest:
            shutil.copyfileobj(src, dest)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA:
            raise ValueError('node_hash')
        STEP = 'create_isolated_service_users'
        for name in USERS.values():
            run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/sbin/nologin', name])
        run(['usermod', '-a', '-G', USERS['writer'] + ',' + USERS['reader'], USERS['credentials']])
        owners = {kind: pwd.getpwnam(name) for kind, name in USERS.items()}
        BASE.mkdir(mode=0o755); CONFIG.mkdir(mode=0o711); STATE.mkdir(mode=0o711)
        node_dir = BASE / ('node-v' + NODE_VERSION); node_dir.mkdir(mode=0o755)
        run(['tar', '-xJf', archive, '--strip-components=1', '-C', node_dir])
        node = node_dir / 'bin/node'
        if run([node, '--version']).strip() != ('v' + NODE_VERSION).encode():
            raise ValueError('node_version')
        release = BASE / ('release-' + digest[:12]); release.mkdir(mode=0o755)
        for name, content in files.items():
            dest = release / name; dest.parent.mkdir(mode=0o755, parents=True, exist_ok=True); dest.write_bytes(content); dest.chmod(0o644)
        # npm has no user config or credentials; lockfile integrity is checked and lifecycle scripts are disabled.
        for dest in [release, *release.rglob('*')]:
            os.chown(dest, owners['credentials'].pw_uid, owners['credentials'].pw_gid)
        cache = tmp / 'npm-cache'; cache.mkdir(); tmp.chmod(0o711); os.chown(cache, owners['credentials'].pw_uid, owners['credentials'].pw_gid)
        STEP = 'install_locked_dependencies'
        run(['runuser', '-u', USERS['credentials'], '--', node, node_dir / 'lib/node_modules/npm/bin/npm-cli.js', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
             '--userconfig=/dev/null', '--globalconfig=/dev/null', '--cache=' + str(cache), '--registry=https://registry.npmjs.org/'], cwd=release, timeout=360)
        for dest in [release, *release.rglob('*')]:
            os.chown(dest, 0, 0, follow_symlinks=False)
        STEP = 'configure_private_services'
        for kind, owner in owners.items():
            folder = CONFIG / kind; folder.mkdir(mode=0o700); os.chown(folder, owner.pw_uid, owner.pw_gid)
            if kind != 'credentials':
                folder = STATE / kind; folder.mkdir(mode=0o700); os.chown(folder, owner.pw_uid, owner.pw_gid)
        private_write(CONFIG / 'credentials/config.json', {'sourceRoleArn': ROLE, 'writerGid': owners['writer'].pw_gid, 'readerGid': owners['reader'].pw_gid}, owners['credentials'])
        certs = {}
        for kind, port in [('writer', 8443), ('reader', 8444)]:
            folder = CONFIG / kind
            run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '90', '-subj', '/CN=clinicaclick-audit-' + kind,
                 '-addext', 'subjectAltName=IP:' + IP + ',IP:127.0.0.1', '-keyout', folder / 'tls.key', '-out', folder / 'tls.crt'])
            for name in ['tls.key', 'tls.crt']:
                os.chmod(folder / name, 0o600); os.chown(folder / name, owners[kind].pw_uid, owners[kind].pw_gid)
            config = {'port': port, 'listenAddress': '0.0.0.0', 'credentialMode': 'unix-scoped', 'credentialBrokerUid': owners['credentials'].pw_uid,
                      'brokerSourceRoleArn': ROLE, 'stateFile': str(STATE / kind / 'state.sqlite'), 'tlsKeyFile': str(folder / 'tls.key'), 'tlsCertFile': str(folder / 'tls.crt')}
            if kind == 'writer':
                config.update(sourceRoleArn=ROLE, principals=[dict(principals['writer'], enabled=True)])
            else:
                config['principals'] = [dict(principals[p], enabled=True, modes=[p]) for p in ['confirmed', 'reconcile']]
            private_write(folder / 'config.json', config, owners[kind]); certs[kind] = (folder / 'tls.crt').read_text()
        units = []
        for kind in USERS:
            filename = Path('/etc/systemd/system/clinicaclick-audit-' + kind + '.service')
            filename.write_text(unit(kind, release, node)); filename.chmod(0o644); units.append(filename)
        STEP = 'verify_units'; run(['systemd-analyze', 'verify', *units])
        run(['systemctl', 'daemon-reload'])
        try:
            for kind in USERS:
                STEP = 'start_' + kind
                name = 'clinicaclick-audit-' + kind + '.service'; started.append(name); run(['systemctl', 'start', name], timeout=40)
            STEP = 'verify_health'; time.sleep(2)
            for name in started:
                if run(['systemctl', 'is-active', name]).strip() != b'active':
                    raise ValueError('service_health')
            # Local HTTPS handshake and closed-route response only; no AWS data operation.
            import ssl
            for kind, port in [('writer', 8443), ('reader', 8444)]:
                context = ssl.create_default_context(cafile=str(CONFIG / kind / 'tls.crt'))
                try:
                    urllib.request.urlopen('https://127.0.0.1:' + str(port) + '/', context=context, timeout=5)
                except urllib.error.HTTPError as error:
                    if error.code != 400:
                        raise
                else:
                    raise ValueError('closed_endpoint')
            run(['systemctl', 'enable', *started])
        except Exception:
            for name in reversed(started):
                subprocess.run(['systemctl', 'stop', name], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=100)
            raise
        result = {'status': 'installed_not_connected', 'instance': INSTANCE, 'artifactSha256': digest, 'node': NODE_VERSION, 'serviceUids': {k: v.pw_uid for k, v in owners.items()},
                  'metadataAndCrossSocketDenial': 'ExecStartPre passed', 'tlsPublicCertificates': certs, 'providersActivated': False, 'realAuditDeliveryVerified': False}
        (BASE / 'installation.json').write_text(json.dumps(result, indent=2) + '\n'); (BASE / 'installation.json').chmod(0o600)
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5 or sys.argv[1] != '--apply':
            raise ValueError('explicit_apply_required')
        install(sys.argv[2], sys.argv[3], sys.argv[4])
    except Exception:
        print('AUDIT_BOOTSTRAP_FAILED stage=' + STEP + '; preserve partial files; no automatic retry', file=sys.stderr)
        sys.exit(1)
