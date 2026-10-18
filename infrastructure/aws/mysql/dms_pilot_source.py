#!/usr/bin/env python3
"""Explicit operator for a fictional, owned DMS source. Import/check-config never starts MySQL."""
import argparse
import ctypes
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time


HOST = '172.26.0.110'
PORT = 23306
SCHEMA = USER = 'cc_dms_pilot'
SERVER_ID = 183306
TLS_DIR = Path('/home/ubuntu/qa-evidence/architecture-diagnostic-20261018-c3CWBj/dms-pilot-tls')
CA_SHA256 = 'e0fb55e67ffa25bb6eacaf8b54e861dfedc6e36f252919c00b539a2d94b85729'
MYSQLD = '/usr/sbin/mysqld'
MYSQL = '/usr/bin/mysql'
RUNTIME_TLS_FILES = ('ca.pem', 'server.pem', 'server.key')


class Refusal(Exception):
    """Only constant, nonsecret error codes may be exposed to the operator."""


def require(ok, code):
    if not ok:
        raise Refusal(code)


def utc(value):
    require(isinstance(value, str), 'review_timestamp_missing')
    try:
        when = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise Refusal('review_timestamp_invalid') from None
    require(when.tzinfo is not None, 'review_timestamp_timezone_required')
    return when


def validate_config(config, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    require(isinstance(config, dict) and set(config) <= {
        'schema', 'aws_profile', 'expected_account_id', 'stack_id', 'pilot_source_secret_arn',
        'dms_private_ipv4', 'runtime_seconds', 'max_owned_bytes', 'firewall_review', 'execution_status', 'recipe'},
        'config_fields_invalid_no_credentials_allowed')
    require(config.get('schema') == 'clinicaclick-dms-pilot-source-config/1', 'config_schema_invalid')
    require(isinstance(config.get('aws_profile'), str)
            and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', config['aws_profile']), 'explicit_aws_profile_required')
    account = config.get('expected_account_id')
    require(isinstance(account, str) and re.fullmatch(r'[0-9]{12}', account), 'expected_account_required')
    stack = config.get('stack_id')
    require(isinstance(stack, str) and re.fullmatch(
        r'arn:aws:cloudformation:eu-west-3:' + account + r':stack/[A-Za-z0-9-]+/[A-Za-z0-9-]+', stack), 'pilot_stack_arn_invalid')
    arn = config.get('pilot_source_secret_arn')
    require(isinstance(arn, str) and re.fullmatch(
        r'arn:aws:secretsmanager:eu-west-3:' + account + r':secret:[A-Za-z0-9/_+=.@-]+', arn), 'source_secret_arn_invalid')
    ips = config.get('dms_private_ipv4')
    require(isinstance(ips, list) and 1 <= len(ips) <= 3 and len(set(ips)) == len(ips), 'exact_dms_addresses_required')
    try:
        require(all(isinstance(ip, str) and ipaddress.ip_address(ip).version == 4
                    and ipaddress.ip_address(ip) in ipaddress.ip_network('172.31.0.0/16') for ip in ips), 'dms_addresses_outside_private_vpc')
    except ValueError:
        raise Refusal('dms_addresses_invalid') from None
    runtime = config.get('runtime_seconds')
    require(type(runtime) is int and 600 <= runtime <= 86400, 'runtime_must_be_10min_to_24h')
    size = config.get('max_owned_bytes')
    require(type(size) is int and 268435456 <= size <= 2147483648, 'owned_space_cap_invalid')
    review = config.get('firewall_review', {})
    require(review.get('source_address') == HOST and review.get('source_port') == PORT
            and review.get('unlisted_sources_denied') is True
            and set(review.get('allowed_dms_ipv4', [])) == set(ips), 'firewall_scope_not_reviewed')
    require(isinstance(review.get('reviewed_by'), str) and bool(review['reviewed_by'].strip())
            and re.fullmatch(r'[0-9a-f]{64}', str(review.get('evidence_sha256'))), 'firewall_evidence_missing')
    observed, expires = utc(review.get('observed_at_utc')), utc(review.get('expires_at_utc'))
    require(-300 <= (now - observed).total_seconds() <= 3600
            and now < expires <= observed + dt.timedelta(hours=24), 'firewall_review_stale')
    require(expires >= now + dt.timedelta(seconds=600), 'firewall_review_expires_too_soon')
    return config


def secure_file(path, mode_limit=0o600):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink()
            and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) & ~mode_limit == 0,
            'unsafe_owned_file')
    return info


def write_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output, indent=2)
        output.write('\n')


def isolated_process_env():
    return {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}


def aws_read(config, service, operation, *args):
    command = ['aws', service, operation, '--profile', config['aws_profile'], '--region', 'eu-west-3',
               '--output', 'json', '--no-cli-pager', *args]
    env = dict(os.environ, AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off')
    try:
        result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=60, check=True)
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, OSError, ValueError):
        # AWS stdout/stderr can contain credentials; never echo either.
        raise Refusal('aws_read_failed') from None


def source_credentials(config):
    identity = aws_read(config, 'sts', 'get-caller-identity')
    require(identity.get('Account') == config['expected_account_id'], 'aws_account_mismatch')
    stacks = aws_read(config, 'cloudformation', 'describe-stacks', '--stack-name', config['stack_id']).get('Stacks', [])
    require(len(stacks) == 1 and stacks[0].get('StackId') == config['stack_id'], 'pilot_stack_identity_mismatch')
    stack = stacks[0]
    outputs = {item.get('OutputKey'): item.get('OutputValue') for item in stack.get('Outputs', [])}
    require(outputs.get('PilotSourceSecretArn') == config['pilot_source_secret_arn'], 'secret_not_source_stack_output')
    require(stack.get('StackStatus') in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}, 'pilot_stack_not_ready')
    detail = aws_read(config, 'secretsmanager', 'describe-secret', '--secret-id', config['pilot_source_secret_arn'])
    tags = {item.get('Key'): item.get('Value') for item in detail.get('Tags', [])}
    require(detail.get('ARN') == config['pilot_source_secret_arn'] and not detail.get('DeletedDate')
            and tags.get('purpose') == 'mysql-synthetic-pilot'
            and tags.get('application') == 'clinicaclick'
            and tags.get('aws:cloudformation:stack-id') == config['stack_id'], 'secret_metadata_not_owned_pilot')
    value = aws_read(config, 'secretsmanager', 'get-secret-value', '--secret-id', config['pilot_source_secret_arn'],
                     '--version-stage', 'AWSCURRENT')
    require(value.get('ARN') == config['pilot_source_secret_arn'] and 'AWSCURRENT' in value.get('VersionStages', []), 'secret_version_mismatch')
    try:
        secret = json.loads(value['SecretString'])
    except (KeyError, TypeError, ValueError):
        raise Refusal('source_secret_format_invalid') from None
    require(isinstance(secret, dict) and set(secret) == {'username', 'password', 'host', 'port', 'dbname'}
            and secret.get('username') == USER and secret.get('host') == HOST
            and secret.get('port') == PORT and secret.get('dbname') == SCHEMA,
            'source_secret_not_synthetic_identity')
    require(isinstance(secret.get('password'), str) and re.fullmatch(r'[A-Za-z0-9]{32}', secret['password']), 'source_secret_password_format_invalid')
    return secret


def bootstrap_sql(secret, ips, run_id):
    # This connection is only the owned local UNIX socket. Credential creation is
    # not written to binlogs, general/slow logs, shell arguments or operator files.
    require(re.fullmatch(r'[0-9a-f]{32}', run_id), 'run_identity_invalid')
    statements = ['SET SESSION sql_log_bin=0', 'CREATE DATABASE cc_dms_pilot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
                  'CREATE TABLE cc_dms_pilot.pilot_identity (id INT PRIMARY KEY, run_id CHAR(32) NOT NULL) ENGINE=InnoDB',
                  "INSERT INTO cc_dms_pilot.pilot_identity VALUES (1,'" + run_id + "')",
                  'CREATE TABLE cc_dms_pilot.pilot_probe (id BIGINT PRIMARY KEY, payload JSON NOT NULL) ENGINE=InnoDB',
                  "INSERT INTO cc_dms_pilot.pilot_probe VALUES (1,JSON_OBJECT('synthetic',true))"]
    require(re.fullmatch(r'[A-Za-z0-9]{32}', str(secret.get('password'))), 'bootstrap_password_format_invalid')
    for ip in ips:
        require(str(ipaddress.IPv4Address(ip)) == ip and ipaddress.IPv4Address(ip) in ipaddress.IPv4Network('172.31.0.0/16'), 'bootstrap_host_invalid')
        account = "'cc_dms_pilot'@'" + ip + "'"
        statements.extend(["CREATE USER " + account + " IDENTIFIED WITH caching_sha2_password BY '" + secret['password'] + "' REQUIRE SSL",
                           'GRANT SELECT ON cc_dms_pilot.* TO ' + account,
                           'GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO ' + account])
    return ';\n'.join(statements) + ';\n'


def mysqld_command(root):
    tls = root / 'tls' / 'original'
    return [MYSQLD, '--no-defaults', '--persisted-globals-load=OFF', '--datadir=' + str(root / 'data'), '--socket=' + str(root / 'mysql.sock'),
            '--pid-file=' + str(root / 'mysqld.pid'), '--bind-address=' + HOST, '--port=' + str(PORT),
            '--mysqlx=OFF', '--skip-name-resolve', '--require-secure-transport=ON',
            '--ssl-ca=' + str(tls / 'ca.pem'), '--ssl-cert=' + str(tls / 'server.pem'),
            '--ssl-key=' + str(tls / 'server.key'), '--tls-version=TLSv1.2',
            '--server-id=' + str(SERVER_ID), '--log-bin=' + str(root / 'data' / 'pilot-bin'),
            '--binlog-format=ROW', '--binlog-row-image=FULL', '--binlog-row-value-options=',
            '--binlog-transaction-compression=OFF', '--binlog-expire-logs-seconds=172800',
            '--max-binlog-size=8388608', '--gtid-mode=OFF', '--event-scheduler=OFF',
            '--general-log=OFF', '--slow-query-log=OFF', '--performance-schema=OFF',
            '--innodb-buffer-pool-size=67108864', '--innodb-redo-log-capacity=33554432',
            '--max-connections=20', '--max-allowed-packet=67108864', '--local-infile=OFF',
            '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci',
            '--log-error=' + str(root / 'mysqld.log')]


def proc_identity(pid):
    proc = Path('/proc') / str(pid)
    raw = (proc / 'stat').read_text()
    return {'start_ticks': raw.rsplit(')', 1)[1].split()[19],
            'args': (proc / 'cmdline').read_bytes().decode().rstrip('\x00').split('\x00')}


def process_matches(pid, expected):
    try:
        return proc_identity(pid) == expected
    except (OSError, ValueError, UnicodeError, IndexError):
        return False


def stop_owned(child, identity):
    if child.poll() is not None:
        return child.returncode == 0
    require(process_matches(child.pid, identity), 'child_identity_changed_no_signal_sent')
    child.send_signal(signal.SIGTERM)
    try:
        return child.wait(timeout=60) == 0
    except subprocess.TimeoutExpired:
        require(process_matches(child.pid, identity), 'child_identity_changed_no_kill_sent')
        child.kill()
        child.wait(timeout=10)
        return False


def owned_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) & 0o077 == 0, 'directory_ownership_invalid')
    return {'device': info.st_dev, 'inode': info.st_ino}


def copy_runtime_tls(root):
    """Only the leaf private key and public certificates enter the owned run."""
    require(root.parent == Path('/tmp') and root.name.startswith('cc-dms-pilot-source-'), 'tls_copy_root_not_owned_namespace')
    owned_directory(root)
    owned_directory(TLS_DIR)
    tls, original = root / 'tls', root / 'tls' / 'original'
    tls.mkdir(mode=0o700)
    original.mkdir(mode=0o700)
    identity = {'tls': owned_directory(tls), 'original': owned_directory(original)}
    def unchanged(a, b):
        return all(getattr(a, field) == getattr(b, field) for field in
                   ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
    for name in RUNTIME_TLS_FILES:
        source = TLS_DIR / name
        expected = secure_file(source)
        require(0 < expected.st_size <= 65536, 'tls_source_size_invalid')
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as incoming:
            observed = os.fstat(incoming.fileno())
            require(unchanged(observed, expected), 'tls_source_changed_before_copy')
            contents = incoming.read(65537)
            require(len(contents) == observed.st_size, 'tls_source_changed_during_copy')
            output_fd = os.open(original / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output_fd, 'wb') as output:
                output.write(contents)
            require(unchanged(os.fstat(incoming.fileno()), observed) and unchanged(source.lstat(), observed),
                    'tls_source_changed_during_copy')
        secure_file(original / name)
    return identity


def cleanup_data(root, root_identity, data_identity, tls_identity=None):
    require(root.parent == Path('/tmp') and root.name.startswith('cc-dms-pilot-source-'), 'cleanup_root_not_owned_namespace')
    require(owned_directory(root) == root_identity and owned_directory(root / 'data') == data_identity, 'cleanup_identity_mismatch')
    require(shutil.rmtree.avoids_symlink_attacks, 'safe_directory_removal_unavailable')
    tls = root / 'tls'
    if tls.exists() or tls.is_symlink():
        require(tls_identity is not None and owned_directory(tls) == tls_identity['tls']
                and owned_directory(tls / 'original') == tls_identity['original'], 'cleanup_tls_identity_mismatch')
        tree_bytes(tls)  # Reject links before removing the owned TLS tree, including the leaf key.
        shutil.rmtree(tls)
    shutil.rmtree(root / 'data')


def tree_bytes(root):
    total = 0
    for directory, children, files in os.walk(root, followlinks=False):
        for name in children + files:
            info = (Path(directory) / name).lstat()
            require(not stat.S_ISLNK(info.st_mode), 'unexpected_owned_tree_symlink')
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
    return total


def sql_socket(root, sql):
    # stdin is the only SQL transport; do not expose stderr/query text on failure.
    require(root.parent == Path('/tmp') and root.name.startswith('cc-dms-pilot-source-'), 'socket_outside_owned_namespace')
    owned_directory(root)
    require(not (root / 'mysql.sock').is_symlink(), 'owned_socket_symlink_forbidden')
    # Clients otherwise read .mylogin.cnf even with --no-defaults. Point the
    # documented test override at a nonexistent file in this private run root.
    login_path = root / 'unused-login-path.cnf'
    require(not login_path.exists() and not login_path.is_symlink(), 'unexpected_login_path_file')
    env = isolated_process_env()
    env['MYSQL_TEST_LOGIN_FILE'] = str(login_path)
    result = subprocess.run([MYSQL, '--no-defaults', '--protocol=SOCKET', '--socket=' + str(root / 'mysql.sock'),
                             '--user=root', '--password=', '--batch', '--raw', '--skip-column-names'],
                            input=sql, capture_output=True, text=True, timeout=30, env=env)
    require(result.returncode == 0, 'owned_socket_sql_failed')
    return result.stdout


def verify_owned_socket(root):
    fields = sql_socket(root, 'SELECT @@datadir,@@socket,@@port,@@bind_address,@@server_id,@@require_secure_transport,@@binlog_format,@@binlog_row_image,@@log_bin,@@gtid_mode,@@have_ssl,@@ssl_ca,@@ssl_cert,@@ssl_key;').strip().split('\t')
    tls = root / 'tls' / 'original'
    expected = [str(root/'data'), str(root/'mysql.sock'), str(PORT), HOST, str(SERVER_ID), '1', 'ROW', 'FULL', '1', 'OFF',
                'YES', str(tls/'ca.pem'), str(tls/'server.pem'), str(tls/'server.key')]
    require(len(fields) == len(expected) and fields[0].rstrip('/') == expected[0]
            and fields[1:] == expected[1:], 'owned_effective_configuration_mismatch_before_writes')


def verify_tls_certificates(directory, config):
    owned_directory(directory)
    for name in RUNTIME_TLS_FILES:
        secure_file(directory / name)
    require(hashlib.sha256((directory / 'ca.pem').read_bytes()).hexdigest() == CA_SHA256, 'pilot_ca_fingerprint_mismatch')
    for args in [['verify', '-CAfile', str(directory / 'ca.pem'), '-verify_ip', HOST, str(directory / 'server.pem')],
                 ['x509', '-in', str(directory / 'server.pem'), '-noout', '-checkend', str(config['runtime_seconds'])]]:
        result = subprocess.run(['openssl', *args], capture_output=True, timeout=10, env=isolated_process_env())
        require(result.returncode == 0, 'pilot_certificate_invalid_or_expiring')


def preflight(config):
    require(os.geteuid() != 0, 'run_as_unprivileged_ubuntu_required')
    for path in [TLS_DIR, TLS_DIR.parent]:
        require(not path.is_symlink() and path.is_dir(), 'tls_directory_unsafe')
    verify_tls_certificates(TLS_DIR, config)
    version = subprocess.run([MYSQLD, '--no-defaults', '--persisted-globals-load=OFF', '--version'], capture_output=True, text=True, timeout=10,
                             env=isolated_process_env())
    require(version.returncode == 0 and re.search(r'\b8\.0\.[0-9]+\b', version.stdout), 'mysql80_binary_required')
    require(shutil.disk_usage('/tmp').free >= 2147483648, 'insufficient_owned_fixture_space')


def child_setup(parent_pid):
    os.umask(0o077)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM) != 0 or os.getppid() != parent_pid:
        os._exit(125)


def run(config, keep_data=False):
    preflight(config)
    secret = source_credentials(config)  # Only now, after reviewed metadata and CA checks.
    validate_config(config)  # AWS calls must not consume the remaining firewall review.
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix='cc-dms-pilot-source-', dir='/tmp'))
    data = root / 'data'; data.mkdir(mode=0o700)
    root_identity, data_identity = owned_directory(root), owned_directory(data)
    run_id = os.urandom(16).hex()
    ownership = {'schema': 'clinicaclick-dms-source-ownership/1', 'run_id': run_id, 'uid': os.geteuid(),
                 'root': str(root), 'root_identity': root_identity, 'data_identity': data_identity,
                 'source_host': HOST, 'source_port': PORT, 'database': SCHEMA, 'synthetic_only': True}
    child = identity = tls_identity = None; error = None; stop_requested = []
    prior = {sig: signal.signal(sig, lambda signum, frame: stop_requested.append(signum))
             for sig in (signal.SIGTERM, signal.SIGINT)}
    started = time.monotonic(); ready = False; clean = False; reason = 'startup_failure'
    # Stop early enough for a graceful shutdown within the review and <=24h cap.
    review_seconds = (utc(config['firewall_review']['expires_at_utc']) - dt.datetime.now(dt.timezone.utc)).total_seconds()
    active_seconds = min(config['runtime_seconds'], review_seconds) - 70
    try:
        tls_identity = copy_runtime_tls(root)
        verify_tls_certificates(root / 'tls' / 'original', config)
        ownership['tls_identity'] = tls_identity
        write_private(root / 'ownership.json', ownership)
        with (root / 'initialize.log').open('xb') as log:
            initialized = subprocess.run([MYSQLD, '--no-defaults', '--persisted-globals-load=OFF', '--initialize-insecure', '--datadir=' + str(data),
                                          '--mysqlx=OFF'], stdout=log, stderr=log, timeout=90,
                                         env=isolated_process_env())
        require(initialized.returncode == 0, 'owned_initialization_failed')
        with (root / 'supervisor.log').open('xb') as log:
            parent_pid = os.getpid()
            child = subprocess.Popen(mysqld_command(root), stdout=log, stderr=log, env=isolated_process_env(),
                                     preexec_fn=lambda: child_setup(parent_pid))
            # The subprocess remains our unreaped child: record its exact args/starttime.
            for _ in range(50):
                if child.poll() is not None:
                    raise Refusal('owned_mysqld_exited_early')
                identity = proc_identity(child.pid)
                if identity['args'] == mysqld_command(root):
                    break
                time.sleep(0.02)
            require(identity is not None and identity['args'] == mysqld_command(root), 'owned_process_arguments_not_proven')
            write_private(root / 'process.json', {'pid': child.pid, **identity})
            while time.monotonic() - started < 90:
                require(child.poll() is None and not stop_requested, 'owned_start_interrupted')
                if (root / 'mysql.sock').exists():
                    try:
                        sql_socket(root, 'SELECT 1;')
                        break
                    except Refusal:
                        pass
                time.sleep(0.2)
            else:
                raise Refusal('owned_readiness_timeout')
            verify_owned_socket(root)  # Fixed read-only identity proof before any SQL writes.
            sql_socket(root, bootstrap_sql(secret, config['dms_private_ipv4'], run_id))
            del secret
            ready = True; reason = 'deadline_reached'
            write_private(root / 'ready.json', {'run_id': run_id, 'synthetic_only': True,
                                               'source_host': HOST, 'source_port': PORT,
                                               'dms_task_started': False, 'runtime_seconds': active_seconds,
                                               'remote_tls_and_dms_connection_tested': False})
            print(json.dumps({'status': 'synthetic_source_ready', 'run_directory': str(root),
                              'deadline_seconds': active_seconds, 'dms_task_started': False}), flush=True)
            while time.monotonic() - started < active_seconds:
                require(child.poll() is None, 'owned_mysqld_exited_during_run')
                require(tree_bytes(root) <= config['max_owned_bytes'], 'owned_space_cap_reached')
                if stop_requested:
                    reason = 'operator_signal'; break
                time.sleep(min(1, max(0, active_seconds - (time.monotonic() - started))))
    except Refusal as failure:
        error = str(failure)
    except (OSError, ValueError, subprocess.SubprocessError):
        error = 'owned_operator_failed'
    finally:
        try:
            if child is not None and identity is not None:
                clean = stop_owned(child, identity)
        except (Refusal, OSError, subprocess.SubprocessError):
            error = 'owned_shutdown_unproven_data_preserved'
        for sig, handler in prior.items():
            signal.signal(sig, handler)
        removed = False
        if ready and clean and error is None and not keep_data:
            try:
                cleanup_data(root, root_identity, data_identity, tls_identity); removed = True
            except (Refusal, OSError):
                error = 'owned_cleanup_failed_data_preserved'
        result = {'status': 'closed_success' if ready and clean and error is None else 'closed_failure',
                  'run_id': run_id, 'reason': reason, 'error_code': error,
                  'clean_shutdown': clean, 'data_removed': removed, 'keep_data_requested': keep_data,
                  'logs_and_results_preserved': True, 'elapsed_seconds': round(time.monotonic() - started, 3),
                  'real_data_or_shared_database_accessed': False, 'dms_task_started': False}
        write_private(root / 'result.json', result)
        print(json.dumps({'run_directory': str(root), **result}), flush=True)
    return 0 if result['status'] == 'closed_success' else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check-config', 'run'])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--ack-isolated-synthetic-source', action='store_true')
    parser.add_argument('--keep-data', action='store_true')
    args = parser.parse_args()
    try:
        secure_file(args.config)
        config = validate_config(json.loads(args.config.read_text()))
        if args.command == 'check-config':
            print(json.dumps({'configuration_valid': True, 'aws_calls_performed': False,
                              'mysql_started': False, 'firewall_independently_verified_by_script': False}))
            return 0
        require(args.ack_isolated_synthetic_source, 'explicit_synthetic_start_ack_required')
        return run(config, args.keep_data)
    except Refusal as failure:
        print(json.dumps({'error_code': str(failure), 'dms_task_started': False})); return 2
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'error_code': 'operator_input_invalid', 'dms_task_started': False})); return 2


if __name__ == '__main__':
    raise SystemExit(main())
