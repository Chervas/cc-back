import copy
import datetime as dt
import json
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import dms_pilot_source as source


NOW = dt.datetime(2026, 10, 18, 15, tzinfo=dt.timezone.utc)
ARN = 'arn:aws:secretsmanager:eu-west-3:000000000000:secret:synthetic-source-ABCDEF'
STACK = 'arn:aws:cloudformation:eu-west-3:000000000000:stack/synthetic-pilot/11111111-2222-3333-4444-555555555555'
PASSWORD = 'FICTIONAL' + '0' * 23


def config():
    return {'schema': 'clinicaclick-dms-pilot-source-config/1', 'aws_profile': 'fictional-profile',
            'expected_account_id': '000000000000', 'stack_id': STACK, 'pilot_source_secret_arn': ARN,
            'dms_private_ipv4': ['172.31.64.20'], 'runtime_seconds': 86400, 'max_owned_bytes': 1073741824,
            'firewall_review': {'reviewed_by': 'fixture-operator', 'observed_at_utc': NOW.isoformat(),
                                'expires_at_utc': (NOW + dt.timedelta(hours=24)).isoformat(),
                                'source_address': source.HOST, 'source_port': source.PORT,
                                'allowed_dms_ipv4': ['172.31.64.20'], 'unlisted_sources_denied': True,
                                'evidence_sha256': 'a' * 64}}


def secret():
    return {'username': 'cc_dms_pilot', 'password': PASSWORD, 'host': source.HOST,
            'port': 23306, 'dbname': 'cc_dms_pilot'}


def aws_responses():
    return [{'Account': '000000000000'},
            {'Stacks': [{'StackId': STACK, 'StackStatus': 'CREATE_COMPLETE',
                         'Outputs': [{'OutputKey': 'PilotSourceSecretArn', 'OutputValue': ARN}]}]},
            {'ARN': ARN, 'Tags': [{'Key': 'purpose', 'Value': 'mysql-synthetic-pilot'},
                                  {'Key': 'application', 'Value': 'clinicaclick'},
                                  {'Key': 'aws:cloudformation:stack-id', 'Value': STACK}]},
            {'ARN': ARN, 'VersionStages': ['AWSCURRENT'], 'SecretString': json.dumps(secret())}]


def fictional_tls(directory):
    directory = Path(directory)
    for name in (*source.RUNTIME_TLS_FILES, 'ca.key'):
        path = directory / name
        path.write_bytes(('FICTIONAL-NOT-A-CERTIFICATE-' + name).encode())
        path.chmod(0o600)
    return directory


class SourceOperatorTests(unittest.TestCase):
    def test_template_is_not_runnable_and_config_does_not_connect(self):
        example = json.loads(Path(__file__).with_name('dms-pilot-source.config.example.json').read_text())
        with self.assertRaises(source.Refusal), patch.object(source, 'aws_read') as aws:
            source.validate_config(example, now=NOW)
        aws.assert_not_called()
        self.assertEqual(source.validate_config(config(), now=NOW)['runtime_seconds'], 86400)

    def test_expired_firewall_wrong_addresses_credentials_and_oversized_runtime_refused(self):
        cases = [lambda c: c.update(runtime_seconds=86401), lambda c: c.update(runtime_seconds=True),
                 lambda c: c.update(dms_private_ipv4=['127.0.0.1']),
                 lambda c: c.update(dms_private_ipv4=['8.8.8.8']),
                 lambda c: c.update(password='forbidden-inline'),
                 lambda c: c['firewall_review'].update(unlisted_sources_denied=False),
                 lambda c: c['firewall_review'].update(source_port=3306),
                 lambda c: c['firewall_review'].update(allowed_dms_ipv4=['172.31.64.21']),
                 lambda c: c['firewall_review'].update(evidence_sha256=None),
                 lambda c: c['firewall_review'].update(observed_at_utc=(NOW-dt.timedelta(hours=2)).isoformat()),
                 lambda c: c['firewall_review'].update(expires_at_utc=(NOW+dt.timedelta(seconds=100)).isoformat())]
        for mutation in cases:
            with self.subTest(mutation=mutation):
                value = config(); mutation(value)
                with self.assertRaises(source.Refusal):
                    source.validate_config(value, now=NOW)

    def test_only_owned_stack_source_secret_can_be_read(self):
        with patch.object(source, 'aws_read', side_effect=aws_responses()) as aws:
            self.assertEqual(source.source_credentials(config()), secret())
        self.assertEqual(aws.call_args_list[-1].args[1:3], ('secretsmanager', 'get-secret-value'))
        for position in (0, 1, 2):
            values = aws_responses()
            if position == 0: values[0]['Account'] = '999999999999'
            if position == 1: values[1]['Stacks'][0]['Outputs'][0]['OutputValue'] = 'master-secret'
            if position == 2: values[2]['Tags'] = []
            with self.subTest(position=position), patch.object(source, 'aws_read', side_effect=values) as aws:
                with self.assertRaises(source.Refusal): source.source_credentials(config())
                self.assertFalse(any(call.args[2] == 'get-secret-value' for call in aws.call_args_list))

    def test_real_or_malformed_secret_payloads_fail_without_exposure(self):
        for key, value in [('host', '127.0.0.1'), ('port', 3306), ('dbname', 'clinicaclick'),
                           ('username', 'ccadmin'), ('password', "quote'password")]:
            values = aws_responses(); payload = secret(); payload[key] = value
            values[-1]['SecretString'] = json.dumps(payload)
            with self.subTest(key=key), patch.object(source, 'aws_read', side_effect=values):
                with self.assertRaises(source.Refusal) as error: source.source_credentials(config())
                self.assertNotIn(str(value), str(error.exception))

    def test_bootstrap_contains_only_fixture_select_plus_replication_and_no_credential_binlog(self):
        sql = source.bootstrap_sql(secret(), ['172.31.64.20'], 'b' * 32)
        self.assertTrue(sql.startswith('SET SESSION sql_log_bin=0;'))
        self.assertIn("'cc_dms_pilot'@'172.31.64.20'", sql)
        self.assertIn('REQUIRE SSL', sql)
        self.assertIn('GRANT SELECT ON cc_dms_pilot.*', sql)
        self.assertIn('GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.*', sql)
        for forbidden in ('clinicaclick', 'GRANT ALL', 'GRANT OPTION', "@'%'", 'FLUSH', 'DROP'):
            self.assertNotIn(forbidden, sql)
        with self.assertRaises(source.Refusal): source.bootstrap_sql(secret(), ['8.8.8.8'], 'b' * 32)

    def test_mysql_commands_force_owned_datadir_tls_binlog_and_no_defaults(self):
        root = Path('/tmp/cc-dms-pilot-source-fictional')
        cmd = source.mysqld_command(root)
        self.assertEqual(cmd[:2], ['/usr/sbin/mysqld', '--no-defaults'])
        for required in ('--persisted-globals-load=OFF', '--bind-address=172.26.0.110', '--port=23306',
                         '--require-secure-transport=ON', '--binlog-format=ROW', '--binlog-row-image=FULL',
                         '--general-log=OFF', '--slow-query-log=OFF', '--performance-schema=OFF', '--gtid-mode=OFF'):
            self.assertIn(required, cmd)
        self.assertNotIn(PASSWORD, ' '.join(cmd))
        self.assertNotIn('/var/lib/mysql', ' '.join(cmd))
        tls = root/'tls'/'original'
        self.assertIn('--ssl-ca='+str(tls/'ca.pem'), cmd)
        self.assertIn('--ssl-cert='+str(tls/'server.pem'), cmd)
        self.assertIn('--ssl-key='+str(tls/'server.key'), cmd)
        self.assertNotIn(str(source.TLS_DIR), ' '.join(cmd))
        self.assertNotIn('ca.key', ' '.join(cmd))

    def test_runtime_tls_copies_only_three_files_to_private_owned_tree(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-', dir='/tmp') as name, \
             tempfile.TemporaryDirectory(prefix='fictional-tls-unit-', dir='/tmp') as original:
            root = Path(name); tls = fictional_tls(original)
            with patch.object(source, 'TLS_DIR', tls):
                identity = source.copy_runtime_tls(root)
            copied = root/'tls'/'original'
            self.assertEqual(set(p.name for p in copied.iterdir()), {'ca.pem','server.pem','server.key'})
            self.assertFalse((copied/'ca.key').exists())
            for path in [root/'tls',copied]: self.assertEqual(path.stat().st_mode & 0o777,0o700)
            for path in copied.iterdir():
                self.assertEqual(path.read_bytes(),(tls/path.name).read_bytes())
                self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(identity['tls'], source.owned_directory(root/'tls'))
            self.assertEqual(identity['original'], source.owned_directory(copied))
            with patch.object(source, 'TLS_DIR', tls), self.assertRaises(FileExistsError):
                source.copy_runtime_tls(root)

    def test_runtime_tls_refuses_symlink_insecure_oversized_and_changed_source(self):
        for mutation in ('symlink','insecure','oversized','changed'):
            with self.subTest(mutation=mutation), \
                 tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-', dir='/tmp') as name, \
                 tempfile.TemporaryDirectory(prefix='fictional-tls-unit-', dir='/tmp') as original:
                root = Path(name); tls = fictional_tls(original); key=tls/'server.key'
                if mutation=='symlink': key.unlink(); key.symlink_to(tls/'ca.key')
                if mutation=='insecure': key.chmod(0o644)
                if mutation=='oversized': key.write_bytes(b'F'*65537)
                secure = source.secure_file
                def inspect(path, mode_limit=0o600):
                    result = secure(path, mode_limit)
                    if mutation=='changed' and path==key:
                        key.rename(tls/'old-server.key');key.write_bytes(b'FICTIONAL-REPLACEMENT');key.chmod(0o600)
                    return result
                with patch.object(source, 'TLS_DIR', tls), patch.object(source, 'secure_file', side_effect=inspect):
                    with self.assertRaises(source.Refusal): source.copy_runtime_tls(root)

    def test_runtime_public_certificates_revalidated_without_executing_openssl(self):
        with tempfile.TemporaryDirectory(prefix='fictional-tls-unit-',dir='/tmp') as name:
            tls=fictional_tls(name);fingerprint=hashlib.sha256((tls/'ca.pem').read_bytes()).hexdigest()
            with patch.object(source,'CA_SHA256',fingerprint), \
                 patch.object(source.subprocess,'run',return_value=Mock(returncode=0)) as command:
                source.verify_tls_certificates(tls,config())
            self.assertEqual(command.call_count,2)
            verify=command.call_args_list[0].args[0]
            self.assertEqual(verify,['openssl','verify','-CAfile',str(tls/'ca.pem'),'-verify_ip',source.HOST,str(tls/'server.pem')])
            self.assertNotIn('ca.key',' '.join(verify))
            with patch.object(source,'CA_SHA256','0'*64), patch.object(source.subprocess,'run') as command:
                with self.assertRaisesRegex(source.Refusal,'pilot_ca_fingerprint_mismatch'):source.verify_tls_certificates(tls,config())
            command.assert_not_called()
            with patch.object(source,'CA_SHA256',fingerprint), patch.object(source.subprocess,'run',return_value=Mock(returncode=1,stderr=PASSWORD)):
                with self.assertRaisesRegex(source.Refusal,'pilot_certificate_invalid_or_expiring') as error:source.verify_tls_certificates(tls,config())
            self.assertNotIn(PASSWORD,str(error.exception))

    def test_cleanup_tls_requires_original_inode_and_removes_leaf_key_not_reports(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-', dir='/tmp') as name, \
             tempfile.TemporaryDirectory(prefix='fictional-tls-unit-', dir='/tmp') as original:
            root=Path(name);data=root/'data';data.mkdir(mode=0o700);(root/'result.json').write_text('{}')
            with patch.object(source,'TLS_DIR',fictional_tls(original)): identity=source.copy_runtime_tls(root)
            rid,did=source.owned_directory(root),source.owned_directory(data)
            wrong=copy.deepcopy(identity);wrong['original']['inode']+=1
            with self.assertRaises(source.Refusal):source.cleanup_data(root,rid,did,wrong)
            self.assertTrue((root/'tls'/'original'/'server.key').exists());self.assertTrue(data.exists())
            source.cleanup_data(root,rid,did,identity)
            self.assertFalse((root/'tls').exists());self.assertFalse(data.exists());self.assertTrue((root/'result.json').exists())

    def test_cleanup_tls_symlink_refused_before_removing_data(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-',dir='/tmp') as name, \
             tempfile.TemporaryDirectory(prefix='fictional-tls-unit-',dir='/tmp') as original:
            root=Path(name);data=root/'data';data.mkdir(mode=0o700)
            with patch.object(source,'TLS_DIR',fictional_tls(original)): identity=source.copy_runtime_tls(root)
            (root/'tls'/'outside').symlink_to(original,target_is_directory=True)
            with self.assertRaises(source.Refusal):source.cleanup_data(root,source.owned_directory(root),source.owned_directory(data),identity)
            self.assertTrue(data.exists());self.assertTrue((root/'tls'/'original'/'server.key').exists())

    def test_sql_password_uses_stdin_never_argv_or_inherited_login(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-', dir='/tmp') as name:
            root = Path(name); sql = source.bootstrap_sql(secret(), ['172.31.64.20'], 'c' * 32)
            with patch.object(source.subprocess, 'run', return_value=Mock(returncode=0, stdout='')) as command:
                source.sql_socket(root, sql)
            args, kwargs = command.call_args
            self.assertNotIn(PASSWORD, ' '.join(args[0]))
            self.assertIn(PASSWORD, kwargs['input'])
            self.assertEqual(kwargs['env']['MYSQL_TEST_LOGIN_FILE'], str(root/'unused-login-path.cnf'))
            self.assertNotIn('MYSQL_PWD', kwargs['env'])
            self.assertNotIn('AWS_SECRET_ACCESS_KEY', kwargs['env'])
            self.assertFalse((root/'unused-login-path.cnf').exists())
            with patch.object(source.subprocess, 'run', return_value=Mock(returncode=1, stdout=PASSWORD, stderr=PASSWORD)):
                with self.assertRaises(source.Refusal) as error: source.sql_socket(root, sql)
                self.assertNotIn(PASSWORD, str(error.exception))

    def test_aws_errors_never_echo_captured_secret(self):
        import subprocess
        error = subprocess.CalledProcessError(1, ['aws'], output=PASSWORD, stderr=PASSWORD)
        with patch.object(source.subprocess, 'run', side_effect=error):
            with self.assertRaises(source.Refusal) as refusal: source.aws_read(config(), 'sts', 'get-caller-identity')
        self.assertEqual(str(refusal.exception), 'aws_read_failed')

    def test_shutdown_never_signals_unproven_process(self):
        child = Mock(pid=999999); child.poll.return_value = None
        with patch.object(source, 'process_matches', return_value=False):
            with self.assertRaises(source.Refusal): source.stop_owned(child, {'args': ['fictional']})
        child.send_signal.assert_not_called(); child.kill.assert_not_called()
        with patch.object(source, 'process_matches', return_value=True):
            child.wait.return_value = 0
            self.assertTrue(source.stop_owned(child, {'args': ['fictional']}))

    def test_cleanup_requires_same_owned_inode_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-', dir='/tmp') as name:
            root = Path(name); root.chmod(0o700); data=root/'data'; data.mkdir(mode=0o700)
            result=root/'result.json'; result.write_text('{}')
            rid, did=source.owned_directory(root), source.owned_directory(data)
            wrong=copy.deepcopy(did); wrong['inode']+=1
            with self.assertRaises(source.Refusal): source.cleanup_data(root, rid, wrong)
            self.assertTrue(data.exists())
            source.cleanup_data(root, rid, did)
            self.assertFalse(data.exists()); self.assertTrue(result.exists())

    def test_symlink_cleanup_and_space_scan_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-pilot-source-', dir='/tmp') as name:
            root=Path(name); root.chmod(0o700); (root/'data').symlink_to('/var/lib/mysql')
            with self.assertRaises(source.Refusal): source.owned_directory(root/'data')
            with self.assertRaises(source.Refusal): source.tree_bytes(root)

    def test_supervisor_cleanup_and_failure_preservation_without_starting_a_process(self):
        # Mock every external operation; only private temporary metadata/files are real.
        for fail_bootstrap, have_ssl, keep_data in [(False,'YES',False),(True,'YES',False),(False,'DISABLED',False),(False,'YES',True)]:
            captured = {}; child = Mock(pid=999999); child.poll.return_value = None
            def fake_popen(command, **kwargs):
                captured['command'] = command
                root = Path(next(arg.split('=', 1)[1] for arg in command if arg.startswith('--datadir='))).parent
                captured['root'] = root; (root/'mysql.sock').touch()
                self.assertTrue((root/'tls'/'original'/'server.key').is_file())
                self.assertFalse((root/'tls'/'original'/'ca.key').exists())
                verify_certs.assert_called_once_with(root/'tls'/'original',config())
                self.assertTrue(callable(kwargs['preexec_fn']))
                self.assertEqual(kwargs['env'], source.isolated_process_env())
                return child
            def fake_sql(root, sql):
                captured.setdefault('sql', []).append(sql)
                if sql.startswith('SET SESSION') and fail_bootstrap:
                    raise source.Refusal('owned_socket_sql_failed')
                if sql.startswith('SELECT @@datadir'):
                    tls=root/'tls'/'original'
                    return str(root/'data')+'/\t'+str(root/'mysql.sock')+'\t23306\t172.26.0.110\t183306\t1\tROW\tFULL\t1\tOFF\t'+have_ssl+'\t'+str(tls/'ca.pem')+'\t'+str(tls/'server.pem')+'\t'+str(tls/'server.key')+'\n'
                return '1\n'
            with self.subTest(fail_bootstrap=fail_bootstrap,have_ssl=have_ssl,keep_data=keep_data), \
                 tempfile.TemporaryDirectory(prefix='fictional-tls-unit-',dir='/tmp') as original, \
                 patch.object(source,'TLS_DIR',fictional_tls(original)), \
                 patch.object(source,'verify_tls_certificates') as verify_certs, \
                 patch.object(source, 'preflight'), patch.object(source, 'validate_config'), \
                 patch.object(source, 'source_credentials', return_value=secret()), \
                 patch.object(source.subprocess, 'run', return_value=Mock(returncode=0)), \
                 patch.object(source.subprocess, 'Popen', side_effect=fake_popen), \
                 patch.object(source, 'proc_identity', side_effect=lambda pid: {'start_ticks':'1','args':captured['command']}), \
                 patch.object(source, 'sql_socket', side_effect=fake_sql), \
                 patch.object(source, 'stop_owned', return_value=True), \
                 patch.object(source.signal, 'signal'), patch.object(source.time, 'monotonic', side_effect=[0,0,90000,90000]), \
                 patch('sys.stdout'):
                status = source.run(config(),keep_data=keep_data)
            root = captured['root']
            try:
                result = json.loads((root/'result.json').read_text())
                failed=fail_bootstrap or have_ssl!='YES';retained=failed or keep_data
                self.assertEqual(status, 2 if failed else 0)
                self.assertEqual((root/'data').exists(), retained)
                self.assertEqual((root/'tls'/'original'/'server.key').exists(), retained)
                self.assertEqual(result['data_removed'], not retained)
                verify_certs.assert_called_once_with(root/'tls'/'original',config())
                self.assertEqual((root/'ready.json').exists(),not failed)
                if have_ssl!='YES':self.assertFalse(any(q.startswith('SET SESSION') for q in captured['sql']))
                self.assertTrue((root/'initialize.log').exists())
                self.assertTrue((root/'supervisor.log').exists())
                self.assertNotIn(PASSWORD, (root/'result.json').read_text())
                self.assertFalse(result['dms_task_started'])
            finally:
                import shutil
                shutil.rmtree(root)

    def test_actual_socket_identity_must_match_before_bootstrap(self):
        root=Path('/tmp/cc-dms-pilot-source-fictional')
        tls=root/'tls'/'original'
        expected=[str(root/'data'),str(root/'mysql.sock'),'23306','172.26.0.110','183306','1','ROW','FULL','1','OFF','YES',str(tls/'ca.pem'),str(tls/'server.pem'),str(tls/'server.key')]
        with patch.object(source,'sql_socket',return_value='\t'.join(expected)):source.verify_owned_socket(root)
        for index, wrong in [(0,'/var/lib/mysql'),(1,'/var/run/mysqld/mysqld.sock'),(2,'3306'),(5,'0'),(8,'0'),(10,'DISABLED'),(10,'NO'),(11,str(source.TLS_DIR/'ca.pem')),(13,str(source.TLS_DIR/'ca.key'))]:
            actual=list(expected);actual[index]=wrong
            with self.subTest(index=index), patch.object(source,'sql_socket',return_value='\t'.join(actual)):
                with self.assertRaises(source.Refusal):source.verify_owned_socket(root)


if __name__ == '__main__':
    unittest.main()
