import contextlib
import copy
import io
import hashlib
import json
from pathlib import Path
import re
import socket
import unittest
from unittest.mock import patch

import dms_pilot_v3 as v3
import dms_task_start_preflight as start
from test_dms_pilot_source import config, NOW


class V3Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = json.loads((v3.ROOT / 'dms-pilot-v3.cloudformation.json').read_text())
        cls.plan = json.loads((v3.ROOT / 'dms-pilot-v3.plan.json').read_text())

    def setUp(self):
        self.process = patch.object(v3.v2.source.subprocess, 'run', side_effect=AssertionError('NO PROCESS/AWS/SQL'))
        self.network = patch.object(socket.socket, 'connect', side_effect=AssertionError('NO NETWORK'))
        self.process.start()
        self.network.start()
        self.addCleanup(self.process.stop)
        self.addCleanup(self.network.stop)

    def test_valid_template_idle_and_twenty_five_exact_owned_resources(self):
        self.assertEqual(v3.validate_template(self.template), [])
        self.assertEqual(len(self.template['Resources']), 25)
        self.assertEqual(self.template['Parameters']['CreatePilotTask']['Default'], 'false')
        self.assertNotIn('ExistingVpcRoleConfirmed', self.template['Parameters'])
        self.assertIsNotNone(re.fullmatch(v3.IDENTIFIER, 'cc-mysql-v3-a1b2c3d4'))
        self.assertIsNone(re.fullmatch(v3.IDENTIFIER, 'cc-mysql-v3-zzzzzzzz'))

    def test_unsafe_scope_network_iam_and_settings_mutations_refuse(self):
        def props(d, name):
            return d['Resources'][name]['Properties']
        def setting(d, mutate):
            p = props(d, 'PilotTask')
            s = json.loads(p['ReplicationTaskSettings'])
            mutate(s)
            p['ReplicationTaskSettings'] = json.dumps(s)
        cases = [
            ('task default on', lambda d: d['Parameters']['CreatePilotTask'].update(Default='true')),
            ('absence defaults satisfied', lambda d: d['Parameters']['DmsVpcRoleAbsenceConfirmed'].update(Default='absent-and-verified')),
            ('foreign consumers guard removed', lambda d: d['Rules']['FreshPilotInfrastructureOnly']['Assertions'].pop()),
            ('absence guards made conditional', lambda d: d['Rules']['FreshPilotInfrastructureOnly'].update(RuleCondition={'Fn::Equals': [{'Ref': 'CreatePilotTask'}, 'true']})),
            ('external template macro', lambda d: d.update(Transform='OtherMacro')),
            ('fresh receipt assertion removed', lambda d: d['Rules']['TaskRequiresSyntheticIdentity']['Assertions'].pop(1)),
            ('task condition removed', lambda d: d['Resources']['PilotTask'].pop('Condition')),
            ('public engine', lambda d: props(d, 'ReplicationInstance').update(PubliclyAccessible=True)),
            ('application source port', lambda d: props(d, 'DmsToSource').update(FromPort=3306, ToPort=3306)),
            ('public logs443', lambda d: props(d, 'DmsToLogsEndpoint').update(CidrIp='0.0.0.0/0')),
            ('foreign logs SG', lambda d: props(d, 'LogsEndpointFromDms').update(SourceSecurityGroupId='sg-foreign')),
            ('default logs egress', lambda d: props(d, 'LogsEndpointSecurityGroup').update(SecurityGroupEgress=[{'IpProtocol': '-1', 'CidrIp': '0.0.0.0/0'}])),
            ('logs endpoint without privateDNS', lambda d: props(d, 'LogsVpcEndpoint').update(PrivateDnsEnabled=False)),
            ('logs endpoint wrong subnet', lambda d: props(d, 'LogsVpcEndpoint').update(SubnetIds=['subnet-foreign'])),
            ('logs endpoint foreign SG', lambda d: props(d, 'LogsVpcEndpoint').update(SecurityGroupIds=['sg-app'])),
            ('logs endpoint public principal', lambda d: props(d, 'LogsVpcEndpoint')['PolicyDocument']['Statement'][1].update(Principal='*')),
            ('logs endpoint resource wide', lambda d: props(d, 'LogsVpcEndpoint')['PolicyDocument']['Statement'][2].update(Resource='*')),
            ('logs endpoint mutating wildcard', lambda d: props(d, 'LogsVpcEndpoint')['PolicyDocument']['Statement'][0].update(Action=['logs:*'])),
            ('logs role trust without account', lambda d: props(d, 'DmsCloudWatchLogsRole')['AssumeRolePolicyDocument']['Statement'][0].pop('Condition')),
            ('vpc role renamed', lambda d: props(d, 'DmsVpcRole').update(RoleName='other-role')),
            ('vpc admin policy', lambda d: props(d, 'DmsVpcRole').update(ManagedPolicyArns=['arn:aws:iam::aws:policy/AdministratorAccess'])),
            ('vpc role broad trust', lambda d: props(d, 'DmsVpcRole')['AssumeRolePolicyDocument']['Statement'][0].update(Principal='*')),
            ('vpc inline operator policy', lambda d: props(d, 'DmsVpcRole').update(Policies=[{'PolicyName': 'OperatorAdmin'}])),
            ('subnets role dependency removed', lambda d: d['Resources']['DmsSubnetGroup'].pop('DependsOn')),
            ('new resource untagged', lambda d: props(d, 'LogsVpcEndpoint').pop('Tags')),
            ('purpose breaks source contract', lambda d: props(d, 'PilotSourceSecret')['Tags'][-2].update(Value='mysql-synthetic-pilot-v3')),
            ('existing secret adopted', lambda d: props(d, 'PilotSourceSecret').update(Name='old-secret')),
            ('TLS weakened', lambda d: props(d, 'SourceEndpoint').update(SslMode='require')),
            ('FK disabled', lambda d: props(d, 'TargetEndpoint')['ExtraConnectionAttributes']['Fn::Sub'].__setitem__(0, 'Initstmt=SET FOREIGN_KEY_CHECKS=0;')),
            ('fullLOB enabled', lambda d: setting(d, lambda s: s['TargetMetadata'].update(FullLobMode=True))),
            ('limitedLOB disabled', lambda d: setting(d, lambda s: s['TargetMetadata'].update(LimitedSizeLobMode=False))),
            ('limit changed', lambda d: setting(d, lambda s: s['TargetMetadata'].update(LobMaxSize=4096))),
            ('inline mixed mode', lambda d: setting(d, lambda s: s['TargetMetadata'].update(InlineLobMaxSize=64))),
            ('batch enabled', lambda d: setting(d, lambda s: s['TargetMetadata'].update(BatchApplyEnabled=True))),
            ('partial validation mismatch', lambda d: setting(d, lambda s: s['ValidationSettings'].update(ValidationPartialLobSize=0))),
            ('skipLOB validation', lambda d: setting(d, lambda s: s['ValidationSettings'].update(SkipLobColumns=True))),
            ('truncate ignored', lambda d: setting(d, lambda s: s['ErrorBehavior'].update(DataTruncationErrorPolicy='LOG_ERROR'))),
            ('logging absent', lambda d: setting(d, lambda s: s['Logging'].update(EnableLogging=False))),
            ('clinical control schema', lambda d: setting(d, lambda s: s['ControlTablesSettings'].update(ControlSchema='clinicaclick'))),
            ('operator IAM resource added', lambda d: d['Resources'].update(OperatorPolicy={'Type': 'AWS::IAM::Policy'})),
            ('inherited gates declared passed', lambda d: d['Metadata']['SyntheticNativeSeedCdc'].update(AllInheritedGatesPassed=True)),
        ]
        for label, mutate in cases:
            with self.subTest(label=label):
                t = copy.deepcopy(self.template)
                mutate(t)
                self.assertTrue(v3.validate_template(t), label)

    def test_frozen_v2_source_harness_fixture_and_preflight_pins(self):
        with patch.dict(v3.PINS, {'dms_pilot_b_fixture.cjs': '0' * 64}):
            self.assertIn('frozen_input_dms_pilot_b_fixture.cjs', v3.validate_template(self.template))

    def test_public_certificate_bytes_unchanged_not_version_renamed(self):
        baseline = json.loads((v3.ROOT / 'dms-pilot-v2.cloudformation.json').read_text())
        for name in ['PilotSourceCertificate', 'RdsTargetCertificate']:
            a = self.template['Resources'][name]['Properties'].get('CertificatePem')
            self.assertEqual(a, baseline['Resources'][name]['Properties'].get('CertificatePem'))
            if isinstance(a, str):
                self.assertEqual(v3.rename(a), a)

    def test_exact_twelve_tables_five_exclusions_and_native_notnull_fixture_unchanged(self):
        t = self.template['Resources']['PilotTask']['Properties']
        rules = json.loads(t['TableMappings'])['rules']
        self.assertEqual(len(rules), 17)
        self.assertEqual([r['object-locator']['table-name'] for r in rules[:12]], v3.v2.TABLES)
        self.assertEqual(len(rules[12:]), 5)
        self.assertTrue(self.plan['lob']['native_NOTNULL_FK1_17mappings_preserved'])

    def test_absence_and_private_dns_are_explicit_blocking_preflight_not_live_proof(self):
        for name in v3.NEW_CONFIRMATIONS:
            self.assertEqual(self.template['Parameters'][name]['Default'], 'no')
        self.assertFalse(self.plan['network']['NAT_IGW_public_egress_created'])
        self.assertIn('VPC-wide', self.plan['network']['private_DNS_impact_scope'])
        self.assertIn('incomplete/access-denied', self.plan['network']['required_before_deploy'])
        self.assertTrue(self.plan['readiness']['CFN_parameters_are_attestations_not_fresh_inventory'])

    def test_limited_mode_is_synthetic_only_and_no_real_maximum_or_timing_claim(self):
        self.assertEqual(v3.L_BYTES, 2097152)
        self.assertFalse(self.plan['lob']['real_maximum_lob_claimed'])
        self.assertFalse(self.plan['lob']['clinical_source_full_scan'])
        self.assertFalse(self.plan['readiness']['clinicalCopyAuthorized'])
        self.assertFalse(self.plan['readiness']['allInheritedGatesPassed'])
        self.assertTrue(self.plan['lob']['partial_DMS_validation_is_not_full_hash_proof'])

    def test_all_twenty_four_boundary_cases_cover_operations_columns_encodings_and_bytes(self):
        cases = v3.boundary_cases()
        self.assertEqual(len(cases), 24)
        self.assertEqual({x['sourceBytes'] for x in cases}, {v3.L_BYTES - 1, v3.L_BYTES, v3.L_BYTES + 1})
        self.assertEqual({x['operation'] for x in cases}, {'INSERT', 'UPDATE'})
        self.assertEqual({x['encoding'] for x in cases}, {'ASCII', 'UTF8_multibyte'})

    BINDING = {'taskArn': 'arn:aws:dms:eu-west-3:137819318729:task:cc-mysql-v3-a1b2c3d4-cdc',
               'sourceRunId': 'a' * 32, 'seedSha256': 'b' * 64}

    def assess(self, case, observed):
        return v3.assess_lob_case(case, observed, binding=self.BINDING)

    def positive(self, case):
        return {**case, 'binding': copy.deepcopy(self.BINDING), 'sourceBytesIndependentlyRead': True, 'sourceMutationCommitted': True,
                'sourceFullSha256': 'a' * 64, 'targetFullSha256': 'a' * 64,
                'targetBytesIndependentlyRead': True, 'targetBytes': case['sourceBytes'],
                'taskStopped': False, 'validationFailures': 0, 'suspendedTables': 0, 'truncationDetected': False}

    def test_positive_requires_independent_full_hash_and_byte_equality_never_partial_validation_alone(self):
        for case in [x for x in v3.boundary_cases() if x['sourceBytes'] <= v3.L_BYTES]:
            obs = self.positive(case)
            self.assertFalse(self.assess(case, obs)['pilotAccepted'])
            for change in [{'targetBytes': case['sourceBytes'] - 1}, {'targetFullSha256': 'b' * 64},
                           {'sourceBytesIndependentlyRead': False}, {'targetBytesIndependentlyRead': False},
                           {'suspendedTables': 1}, {'validationFailures': 1}, {'truncationDetected': True}]:
                with self.subTest(case=case, change=change), self.assertRaises(v3.v2.source.Refusal):
                    self.assess(case, {**obs, **change})

    def oversize(self, case):
        return {**self.positive(case), 'taskStopped': True, 'targetMutationAbsent': True,
                'targetSnapshotIndependentlyRead': True, 'targetBeforeFullSha256': 'c' * 64,
                'targetAfterFullSha256': 'c' * 64, 'manualStopObserved': False, 'unrelatedFailureObserved': False,
                'caseStartedAtMs': 1792340000000 - 1000, 'caseFinishedAtMs': 1792340000000 + 1000,
                'stopCauseEvidence': {'binding': copy.deepcopy(self.BINDING),
                    'caseSha256': hashlib.sha256(json.dumps(case, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                    'table': 'b_lob', 'column': case['column'].split('.')[1], 'rowId': case['rowId'],
                    'operation': case['operation'], 'sourceBytes': case['sourceBytes'], 'limitBytes': v3.L_BYTES,
                    'cause': 'LOB_SIZE_LIMIT_EXCEEDED', 'origin': 'bound_task_cloudwatch_event',
                    'rawEventSha256': 'e' * 64, 'eventTimestampMs': 1792340000000,
                    'logGroup': 'dms-tasks-cc-mysql-v3-a1b2c3d4', 'logStream': 'dms-task-cc-mysql-v3-a1b2c3d4-cdc'}}

    def test_oversize_expected_rejection_requires_stop_and_independent_unchanged_target_snapshot(self):
        for case in [x for x in v3.boundary_cases() if x['sourceBytes'] > v3.L_BYTES]:
            obs = self.oversize(case)
            result = self.assess(case, obs)
            self.assertEqual(result['status'], 'EXPECTED_OVERSIZE_REJECTION')
            self.assertTrue(result['stopAndReview'])
            self.assertFalse(result['pilotAccepted'])
            for change in [{'taskStopped': False}, {'targetMutationAbsent': False}, {'truncationDetected': True},
                           {'targetSnapshotIndependentlyRead': False}, {'targetAfterFullSha256': 'd' * 64}]:
                with self.subTest(case=case, change=change), self.assertRaises(v3.v2.source.Refusal):
                    self.assess(case, {**obs, **change})

    def test_boundary_unknown_case_or_cross_binding_cannot_pass(self):
        case = v3.boundary_cases()[0]
        with self.assertRaises(v3.v2.source.Refusal):
            self.assess({**case, 'sourceBytes': 10}, {})
        with self.assertRaises(v3.v2.source.Refusal):
            self.assess(case, {**self.positive(case), 'encoding': 'wrong'})

    def test_oversize_stop_for_network_auth_secrets_manual_or_wrong_case_is_not_lob_rejection(self):
        case = next(x for x in v3.boundary_cases() if x['sourceBytes'] > v3.L_BYTES)
        base = self.oversize(case)
        changes = [{'manualStopObserved': True}, {'unrelatedFailureObserved': True}, {'stopCauseEvidence': {}},
                   {'caseStartedAtMs': 1792340000001}, {'caseFinishedAtMs': 1792339999999}]
        changes += [{'stopCauseEvidence': {**base['stopCauseEvidence'], 'cause': reason}}
                    for reason in ['NETWORK_FAILURE', 'AUTHENTICATION_FAILURE', 'SECRETS_MANAGER_FAILURE', 'MANUAL_STOP']]
        changes += [{'stopCauseEvidence': {**base['stopCauseEvidence'], key: value}} for key, value in [
            ('table', 'other'), ('column', 'other'), ('rowId', 9999), ('operation', 'other'),
            ('caseSha256', 'f' * 64), ('rawEventSha256', ''), ('origin', 'inferred_from_stopped'),
            ('logGroup', 'other-group'), ('logStream', 'other-stream'), ('limitBytes', 1),
            ('binding', {**self.BINDING, 'taskArn': 'foreign'})]]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(v3.v2.source.Refusal):
                self.assess(case, {**base, **change})

    def test_source_plan_is_v3_detached_only_and_future_paid_deadline_is_proposed(self):
        nonce = 'c' * 32
        evidence = '/home/ubuntu/qa-evidence/dms-pilot-v3-' + nonce
        c = config()
        c['runtime_seconds'] = 3600
        result = v3.source_launch_plan(c, evidence + '/source.config.json', nonce, evidence, now=NOW)
        self.assertEqual(result['unit'], 'cc-dms-pilot-source-v3-' + nonce + '.service')
        self.assertFalse(result['executeAutomatically'])
        self.assertFalse(result['sourceStarted'])
        self.assertIn(evidence + '/source.config.json', result['commandForRootReview'])
        self.assertEqual(result['maximumServiceSecondsIncludingStop'], 4290)
        self.assertEqual(result['paidTeardownReview']['state'], 'PROPOSED_NOT_STARTED')
        self.assertIsNone(result['paidTeardownReview']['atUtc'])
        self.assertIsNone(self.plan['runtime_and_paid_review']['proposed_paid_teardown_review_at_utc'])

    def test_source_plan_rejects_old_paths_and_frozen_code_drift(self):
        nonce = 'd' * 32
        path = '/home/ubuntu/qa-evidence/dms-pilot-v3-' + nonce
        with self.assertRaises(v3.v2.source.Refusal):
            v3.source_launch_plan(config(), '/tmp/source.config.json', nonce, path, now=NOW)
        with patch.dict(v3.PINS, {'dms_pilot_source.py': '0' * 64}), self.assertRaises(v3.v2.source.Refusal):
            v3.source_launch_plan(config(), path + '/source.config.json', nonce, path, now=NOW)

    def test_canonical_readonly_start_binding_accepts_fresh_v3_ids_without_aws_calls(self):
        prefix = 'arn:aws:dms:eu-west-3:137819318729:'
        binding = {'schema': 'clinicaclick-dms-vnc-start-binding/1', 'aws_profile': 'clinicaclick-prov-temp',
                   'account_id': '137819318729', 'region': 'eu-west-3',
                   'stack_arn': 'arn:aws:cloudformation:eu-west-3:137819318729:stack/clinicaclick-mysql-dms-v3-a1b2c3d4/11111111-2222-4333-8444-555555555555',
                   'logical_task_id': 'PilotTask', 'task_arn': prefix + 'task:cc-mysql-v3-a1b2c3d4-cdc',
                   'replication_instance_arn': prefix + 'rep:cc-mysql-v3-a1b2c3d4',
                   'source_endpoint_arn': prefix + 'endpoint:cc-mysql-v3-a1b2c3d4-source',
                   'target_endpoint_arn': prefix + 'endpoint:cc-mysql-v3-a1b2c3d4-target',
                   'expected_tags': {'purpose': 'mysql-synthetic-pilot', 'application': 'clinicaclick', 'pilot-version': 'v3'}}
        with patch.object(start, 'aws_read', side_effect=AssertionError('NO AWS')):
            self.assertEqual(start.validate_binding(binding), binding)

    def test_cli_only_checks_and_never_claims_deployment_or_execution(self):
        out = io.StringIO()
        with patch('sys.argv', ['dms_pilot_v3.py', 'check-template']), contextlib.redirect_stdout(out):
            self.assertEqual(v3.main(), 0)
        receipt = json.loads(out.getvalue())
        self.assertFalse(receipt['deploymentAuthorized'])
        self.assertFalse(receipt['operationsPerformed'])
        self.assertFalse(receipt['awsAccountValidationPerformed'])


if __name__ == '__main__':
    unittest.main()
