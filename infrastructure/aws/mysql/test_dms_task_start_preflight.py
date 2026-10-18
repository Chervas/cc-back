import contextlib
import copy
import datetime as dt
import io
import json
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import dms_task_start_preflight as pre

STACK = 'arn:aws:cloudformation:eu-west-3:137819318729:stack/clinicaclick-mysql-dms-qa/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
PREFIX = 'arn:aws:dms:eu-west-3:137819318729:'
NOW = dt.datetime(2026, 10, 18, 17, tzinfo=dt.timezone.utc)


def binding():
    return {'schema': 'clinicaclick-dms-vnc-start-binding/1', 'aws_profile': 'synthetic-test-only',
            'account_id': pre.ACCOUNT, 'region': pre.REGION, 'stack_arn': STACK, 'logical_task_id': 'PilotTask',
            'task_arn': PREFIX + 'task:FAKE-TASK', 'replication_instance_arn': PREFIX + 'rep:FAKE-REP',
            'source_endpoint_arn': PREFIX + 'endpoint:FAKE-SOURCE', 'target_endpoint_arn': PREFIX + 'endpoint:FAKE-TARGET',
            'expected_tags': {'application': 'clinicaclick', 'purpose': 'mysql-synthetic-pilot', 'pilot-version': 'v9'}}


class FakeAws:
    def __init__(self):
        b = binding()
        self.calls = []
        self.account = pre.ACCOUNT
        self.arn = 'arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_SyntheticTest_0123456789abcdef/fictional-session'
        self.stack = {'StackId': STACK, 'StackStatus': 'CREATE_COMPLETE', 'CreationTime': 'fixed-creation'}
        self.resource = {'StackId': STACK, 'LogicalResourceId': 'PilotTask', 'PhysicalResourceId': b['task_arn'],
                         'ResourceType': 'AWS::DMS::ReplicationTask', 'ResourceStatus': 'CREATE_COMPLETE',
                         'LastUpdatedTimestamp': 'fixed-resource-time'}
        self.task = {'ReplicationTaskArn': b['task_arn'], 'ReplicationInstanceArn': b['replication_instance_arn'],
                     'SourceEndpointArn': b['source_endpoint_arn'], 'TargetEndpointArn': b['target_endpoint_arn'], 'Status': 'ready'}
        self.rep = {'ReplicationInstanceArn': b['replication_instance_arn'], 'ReplicationInstanceStatus': 'available', 'PubliclyAccessible': False}
        self.endpoints = {b[k + '_endpoint_arn']: {'EndpointArn': b[k + '_endpoint_arn'], 'EndpointType': k.upper(),
                          'EngineName': 'mysql', 'SslMode': 'verify-full'} for k in ['source', 'target']}
        self.tags = [{'Key': k, 'Value': v} for k, v in b['expected_tags'].items()]
        self.final_stack = self.final_resource = self.final_task = None
        self.orphan = False

    def __call__(self, b, service, operation, *args):
        assert (service, operation) in pre.READS, 'NO WRITES OR SECRETS'
        count = sum((s, o) == (service, operation) for s, o, _ in self.calls)
        self.calls.append((service, operation, args))
        if operation == 'get-caller-identity':
            return {'Account': self.account, 'Arn': self.arn}
        if operation == 'describe-stacks':
            return {'Stacks': [copy.deepcopy(self.final_stack if count and self.final_stack is not None else self.stack)]}
        if operation == 'describe-stack-resource':
            if self.orphan:
                raise pre.Refusal('dms_start_aws_read_failed')
            return {'StackResourceDetail': copy.deepcopy(self.final_resource if count and self.final_resource is not None else self.resource)}
        if operation == 'describe-replication-tasks':
            return {'ReplicationTasks': [copy.deepcopy(self.final_task if count and self.final_task is not None else self.task)]}
        if operation == 'describe-replication-instances':
            return {'ReplicationInstances': [copy.deepcopy(self.rep)]}
        if operation == 'describe-endpoints':
            return {'Endpoints': [copy.deepcopy(self.endpoints[args[1].split('Values=')[1]])]}
        if operation == 'list-tags-for-resource':
            return {'TagList': copy.deepcopy(self.tags)}
        raise AssertionError('Unexpected read')


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.block_real_process = patch.object(pre.subprocess, 'run', side_effect=AssertionError('NO REAL AWS/SQL/PROCESS'))
        self.block_real_process.start()
        self.addCleanup(self.block_real_process.stop)

    def check(self, fake=None, b=None):
        return pre.check(b or binding(), aws=fake or FakeAws(), now=lambda: NOW)

    def test_ready_only_after_stable_cfn_membership_and_final_rechecks(self):
        fake = FakeAws()
        def clock():
            self.assertEqual(fake.calls[-1][:2], ('cloudformation', 'describe-stacks'))
            return NOW
        result = pre.check(binding(), aws=fake, now=clock)
        self.assertEqual(result['status'], 'READY_FOR_VNC_START')
        self.assertEqual(result['checkedAt'], NOW.isoformat())
        self.assertFalse(result['automaticStartPerformed'])
        self.assertFalse(result['awsWritesPerformed'])
        self.assertFalse(result['sqlPerformed'])
        self.assertFalse(result['secretValuesRead'])
        self.assertTrue(result['recheckImmediatelyBeforeVncStart'])
        self.assertEqual(len([c for c in fake.calls if c[1] == 'describe-stacks']), 2)
        self.assertEqual(len([c for c in fake.calls if c[1] == 'describe-stack-resource']), 2)
        self.assertEqual(len([c for c in fake.calls if c[1] == 'list-tags-for-resource']), 4)

    def test_ready_dms_task_cannot_override_updating_rollback_or_deleted_cfn(self):
        for status in ['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
                       'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
                       'ROLLBACK_COMPLETE', 'DELETE_FAILED', 'DELETE_COMPLETE']:
            with self.subTest(status=status):
                fake = FakeAws(); fake.stack['StackStatus'] = status
                with self.assertRaisesRegex(pre.Refusal, 'stack_not_stable'):
                    self.check(fake)
                self.assertFalse(any(c[0] == 'dms' for c in fake.calls))

    def test_update_complete_is_valid_but_resource_must_also_be_complete(self):
        fake = FakeAws(); fake.stack['StackStatus'] = fake.resource['ResourceStatus'] = 'UPDATE_COMPLETE'
        self.assertEqual(self.check(fake)['status'], 'READY_FOR_VNC_START')
        for status in ['CREATE_IN_PROGRESS', 'DELETE_FAILED', 'DELETE_COMPLETE', 'UPDATE_IN_PROGRESS']:
            fake = FakeAws(); fake.resource['ResourceStatus'] = status
            with self.assertRaisesRegex(pre.Refusal, 'task_resource_not_stable'):
                self.check(fake)

    def test_orphan_or_wrong_physical_cfn_task_cannot_use_ready_api_task(self):
        fake = FakeAws(); fake.orphan = True
        with self.assertRaises(pre.Refusal): self.check(fake)
        for key, value in [('PhysicalResourceId', PREFIX + 'task:OTHER'), ('StackId', STACK + '-other'),
                           ('LogicalResourceId', 'OtherTask'), ('ResourceType', 'AWS::DMS::Endpoint')]:
            fake = FakeAws(); fake.resource[key] = value
            with self.assertRaisesRegex(pre.Refusal, 'task_not_owned_by_stack'): self.check(fake)

    def test_sts_wrong_account_refuses_before_any_resource_reads(self):
        fake = FakeAws(); fake.account = '000000000000'
        with self.assertRaisesRegex(pre.Refusal, 'sts_account_mismatch'): self.check(fake)
        self.assertEqual(len(fake.calls), 1)

    def test_root_iam_user_and_non_sso_or_invalid_sessions_rejected_before_resource_reads(self):
        for arn in ['arn:aws:iam::137819318729:root', 'arn:aws:iam::137819318729:user/fictional',
                    'arn:aws:sts::137819318729:assumed-role/OrdinaryRole/fictional-session',
                    'arn:aws:sts::000000000000:assumed-role/AWSReservedSSO_Other/fictional-session',
                    'arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_Test/',
                    'arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_Test/a',
                    'arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_Test/not/a/session', None]:
            with self.subTest(arn=arn):
                fake = FakeAws(); fake.arn = arn
                with self.assertRaisesRegex(pre.Refusal, 'assigned_sso_session_required'):
                    self.check(fake)
                self.assertEqual(len(fake.calls), 1)

    def test_exact_task_rep_and_endpoints_bound_and_no_automatic_resume(self):
        for key in ['ReplicationTaskArn', 'ReplicationInstanceArn', 'SourceEndpointArn', 'TargetEndpointArn']:
            fake = FakeAws(); fake.task[key] += '-other'
            with self.assertRaisesRegex(pre.Refusal, 'task_binding_mismatch'): self.check(fake)
        for status in ['starting', 'running', 'stopped', 'stopping', 'failed']:
            fake = FakeAws(); fake.task['Status'] = status
            with self.assertRaisesRegex(pre.Refusal, 'task_not_ready'): self.check(fake)

    def test_private_available_replica_and_verify_full_endpoint_required(self):
        for key, value in [('PubliclyAccessible', True), ('ReplicationInstanceStatus', 'modifying')]:
            fake = FakeAws(); fake.rep[key] = value
            with self.assertRaisesRegex(pre.Refusal, 'private_instance_not_ready'): self.check(fake)
        for key, value in [('SslMode', 'require'), ('EngineName', 'postgres'), ('EndpointType', 'target'), ('EndpointArn', 'other')]:
            fake = FakeAws(); fake.endpoints[binding()['source_endpoint_arn']][key] = value
            with self.assertRaisesRegex(pre.Refusal, 'endpoint_binding_or_tls_mismatch'): self.check(fake)

    def test_wrong_missing_duplicate_or_foreign_resource_tags_refused(self):
        for tags in [[], [{'Key': 'purpose', 'Value': 'clinical'}], FakeAws().tags + [FakeAws().tags[0]],
                     [dict(t, ResourceArn=PREFIX + 'task:OTHER') for t in FakeAws().tags]]:
            fake = FakeAws(); fake.tags = tags
            with self.assertRaises(pre.Refusal): self.check(fake)

    def test_cfn_or_task_drift_during_check_refuses_instead_of_stale_ready(self):
        for kind, key, value in [('stack', 'StackStatus', 'UPDATE_IN_PROGRESS'),
                                 ('stack', 'LastUpdatedTime', 'new-update-even-if-complete'),
                                 ('resource', 'PhysicalResourceId', PREFIX + 'task:OTHER'),
                                 ('task', 'Status', 'running')]:
            fake = FakeAws(); changed = copy.deepcopy(getattr(fake, kind)); changed[key] = value
            setattr(fake, 'final_' + kind, changed)
            with self.assertRaises(pre.Refusal): self.check(fake)

    def test_binding_rejects_wrong_region_account_and_credential_fields_before_reads(self):
        for key, value in [('region', 'us-east-1'), ('account_id', '000000000000'), ('password', 'DO-NOT-READ'),
                           ('source_endpoint_arn', binding()['target_endpoint_arn'])]:
            b = binding(); b[key] = value; fake = FakeAws()
            with self.assertRaises(pre.Refusal): self.check(fake, b)
            self.assertEqual(fake.calls, [])

    def test_wrapper_allows_only_metadata_reads_and_forces_explicit_profile_paris(self):
        response = subprocess.CompletedProcess([], 0, stdout=json.dumps({'Account': pre.ACCOUNT, 'Arn': FakeAws().arn}))
        with patch.object(pre.subprocess, 'run', return_value=response) as run:
            self.assertEqual(pre.aws_read(binding(), 'sts', 'get-caller-identity')['Account'], pre.ACCOUNT)
            command = run.call_args.args[0]
            self.assertEqual(command[command.index('--region') + 1], 'eu-west-3')
            self.assertEqual(command[command.index('--profile') + 1], 'synthetic-test-only')
            self.assertEqual(run.call_args.kwargs['timeout'], 15)
            self.assertNotIn('shell', run.call_args.kwargs)
        with patch.object(pre.subprocess, 'run') as run:
            for service, operation in [('dms', 'start-replication-task'), ('dms', 'modify-replication-task'),
                                       ('secretsmanager', 'get-secret-value')]:
                with self.assertRaisesRegex(pre.Refusal, 'non_read_operation_forbidden'):
                    pre.aws_read(binding(), service, operation)
            run.assert_not_called()

    def test_denied_cli_never_treated_as_absent_or_ready_and_stderr_not_printed(self):
        error = subprocess.CalledProcessError(254, [], stderr='AccessDenied SECRET-SENTINEL password=NEVER-EMIT')
        output = io.StringIO()
        with patch.object(pre, 'read_binding', return_value=binding()), patch.object(pre.subprocess, 'run', side_effect=error), contextlib.redirect_stdout(output):
            self.assertEqual(pre.main(['--binding', 'ignored-by-mock.json']), 2)
        self.assertEqual(json.loads(output.getvalue()), {'status': 'REFUSED', 'code': 'dms_start_aws_read_failed'})
        self.assertNotIn('SECRET-SENTINEL', output.getvalue())

    def test_binding_file_must_be_private_and_not_a_symlink(self):
        with tempfile.TemporaryDirectory(prefix='cc-dms-start-offline-') as folder:
            file = Path(folder) / 'binding.json'; file.write_text(json.dumps(binding())); file.chmod(0o600)
            self.assertEqual(pre.read_binding(file), binding())
            file.chmod(0o644)
            with self.assertRaises(pre.Refusal): pre.read_binding(file)
            file.chmod(0o600); link = Path(folder) / 'link.json'; link.symlink_to(file)
            with self.assertRaises(pre.Refusal): pre.read_binding(link)


if __name__ == '__main__':
    unittest.main()
