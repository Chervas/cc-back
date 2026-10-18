import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import dms_pilot_v2 as v2
from test_dms_pilot_source import config, NOW, aws_responses, STACK, secret


class V2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = json.loads(Path(__file__).with_name('dms-pilot-v2.cloudformation.json').read_text())

    def test_valid_candidate_is_offline_idle_and_scope_is_twelve_fixtures(self):
        with patch.object(v2.source.subprocess, 'run', side_effect=AssertionError('NO PROCESS OR NETWORK')):
            self.assertEqual(v2.validate_template(self.template), [])
        self.assertEqual(len(self.template['Resources']), 20)
        self.assertNotIn('DmsVpcRole', self.template['Resources'])
        self.assertEqual(self.template['Parameters']['CreatePilotTask']['Default'], 'false')

    def test_unsafe_mutations_rejected(self):
        def setting(d, mutate):
            p = d['Resources']['PilotTask']['Properties']
            s = json.loads(p['ReplicationTaskSettings']); mutate(s)
            p['ReplicationTaskSettings'] = json.dumps(s)
        cases = [
            ('logging off', lambda d: setting(d, lambda s: s['Logging'].update(EnableLogging=False))),
            ('debug payloads', lambda d: setting(d, lambda s: s['Logging']['LogComponents'][0].update(Severity='LOGGER_SEVERITY_DEBUG'))),
            ('group override', lambda d: setting(d, lambda s: s['Logging'].update(CloudWatchLogGroup='other'))),
            ('limited lob', lambda d: setting(d, lambda s: s['TargetMetadata'].update(FullLobMode=False))),
            ('batch apply', lambda d: setting(d, lambda s: s['TargetMetadata'].update(BatchApplyEnabled=True))),
            ('other control schema', lambda d: setting(d, lambda s: s['ControlTablesSettings'].update(ControlSchema='clinicaclick'))),
            ('ignore errors', lambda d: setting(d, lambda s: s['ErrorBehavior'].update(ApplyErrorInsertPolicy='IGNORE_RECORD'))),
            ('public instance', lambda d: d['Resources']['ReplicationInstance']['Properties'].update(PubliclyAccessible=True)),
            ('unbounded storage', lambda d: d['Resources']['ReplicationInstance']['Properties'].update(AllocatedStorage=1000)),
            ('clinical port', lambda d: d['Resources']['DmsToSource']['Properties'].update(FromPort=3306, ToPort=3306)),
            ('wrong egress group', lambda d: d['Resources']['DmsToSource']['Properties'].update(GroupId='sg-application')),
            ('public source cidr', lambda d: d['Resources']['DmsToSource']['Properties'].update(CidrIp='0.0.0.0/0')),
            ('weak TLS', lambda d: d['Resources']['TargetEndpoint']['Properties'].update(SslMode='require')),
            ('FK disabled', lambda d: d['Resources']['TargetEndpoint']['Properties']['ExtraConnectionAttributes']['Fn::Sub'].__setitem__(0, 'Initstmt=SET FOREIGN_KEY_CHECKS=0;')),
            ('broad logs policy', lambda d: d['Resources']['DmsCloudWatchLogsRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'][2].update(Resource='*')),
            ('operator role changed', lambda d: d['Resources'].__setitem__('OperatorRole', {'Type': 'AWS::IAM::Role'})),
            ('wrong principal', lambda d: d['Resources']['DmsCloudWatchLogsRole']['Properties']['AssumeRolePolicyDocument']['Statement'][0]['Principal'].update(Service='ec2.amazonaws.com')),
            ('no SourceAccount', lambda d: d['Resources']['DmsCloudWatchLogsRole']['Properties']['AssumeRolePolicyDocument']['Statement'][0].pop('Condition')),
            ('long retention', lambda d: d['Resources']['PilotLogGroup']['Properties'].update(RetentionInDays=365)),
            ('adopt old group', lambda d: d['Resources']['PilotLogGroup']['Properties'].update(LogGroupName='dms-tasks-existing')),
            ('reuse coordinate', lambda d: d['Resources']['PilotTask']['Properties'].update(CdcStartPosition='pilot-bin.000001:4662134')),
            ('task default on', lambda d: d['Parameters']['CreatePilotTask'].update(Default='true')),
            ('no cleanup proof', lambda d: d['Rules']['FreshPilotInfrastructureOnly']['Assertions'].pop(0)),
            ('no receipt proof', lambda d: d['Rules']['TaskRequiresSyntheticIdentity']['Assertions'].pop()),
            ('inverted task condition', lambda d: d['Rules']['TaskRequiresSyntheticIdentity'].update(RuleCondition={'Fn::Equals': [{'Ref': 'CreatePilotTask'}, 'false']})),
        ]
        for name, mutate in cases:
            with self.subTest(name=name):
                d = copy.deepcopy(self.template); mutate(d)
                self.assertTrue(v2.validate_template(d))

    def test_wildcard_selection_and_additional_transformation_rejected(self):
        for mutate in [lambda m: m['rules'][0]['object-locator'].update(**{'table-name': '%'}),
                       lambda m: m['rules'].append({'rule-type': 'transformation', 'rule-action': 'rename', 'rule-target': 'schema', 'object-locator': {'schema-name': 'cc_dms_pilot'}, 'value': 'clinicaclick'})]:
            d = copy.deepcopy(self.template); p = d['Resources']['PilotTask']['Properties']
            m = json.loads(p['TableMappings']); mutate(m); p['TableMappings'] = json.dumps(m)
            self.assertTrue(v2.validate_template(d))

    def test_template_source_secret_tags_match_unchanged_source_contract(self):
        responses = aws_responses()
        tags = copy.deepcopy(self.template['Resources']['PilotSourceSecret']['Properties']['Tags'])
        responses[2]['Tags'] = tags + [{'Key': 'aws:cloudformation:stack-id', 'Value': STACK}]
        with patch.object(v2.source, 'aws_read', side_effect=responses):
            self.assertEqual(v2.source.source_credentials(config()), secret())
        for tag in responses[2]['Tags']:
            if tag['Key'] == 'purpose': tag['Value'] = 'mysql-synthetic-pilot-v2'
        with patch.object(v2.source, 'aws_read', side_effect=responses) as aws:
            with self.assertRaisesRegex(v2.source.Refusal, 'secret_metadata_not_owned_pilot'):
                v2.source.source_credentials(config())
        self.assertFalse(any(call.args[2] == 'get-secret-value' for call in aws.call_args_list))

    def test_source_launch_plan_cannot_execute_or_inherit_scope_pipe_pty(self):
        c = config(); c['runtime_seconds'] = 3600; nonce = 'a' * 32
        evidence = '/home/ubuntu/qa-evidence/dms-pilot-v2-' + nonce
        with patch.object(v2.source.subprocess, 'run', side_effect=AssertionError('NO SYSTEMD/AWS/SQL')):
            plan = v2.source_launch_plan(c, evidence + '/source.config.json', nonce, evidence, now=NOW)
        cmd = plan['commandForRootReview']
        self.assertEqual(cmd[:4], ['/usr/bin/sudo', '-n', '/usr/bin/systemd-run', '--system'])
        for prop in ['Type=exec', 'User=ubuntu', 'Group=ubuntu', 'RuntimeMaxSec=4200', 'TimeoutStopSec=90', 'Restart=no', 'KillMode=mixed', 'PrivateTmp=no']:
            self.assertIn('--property=' + prop, cmd)
        for flag in ['--scope', '--pipe', '--pty', '--wait', '--collect']:
            self.assertNotIn(flag, cmd)
        self.assertIn('--ack-isolated-synthetic-source', cmd); self.assertNotIn('--keep-data', cmd)
        self.assertFalse(plan['executeAutomatically']); self.assertFalse(plan['sourceStarted']); self.assertFalse(plan['systemdInvoked'])
        self.assertNotIn('EnvironmentFile=', str(plan)); self.assertNotIn('systemctl restart', str(plan))
        self.assertFalse(plan['clinicalCopyAuthorized']); self.assertEqual(plan['activeRuntimeLimitSeconds'], 4200)
        self.assertEqual(plan['maximumServiceSecondsIncludingStop'], 4290)

    def test_source_plan_rejects_unowned_paths_long_runtime_and_shell_characters(self):
        nonce = 'b' * 32; evidence = '/home/ubuntu/qa-evidence/dms-pilot-v2-' + nonce
        for config_path, key, folder, runtime in [(evidence + '/source.config.json', 'bad', evidence, 3600),
              ('/etc/source.config.json', nonce, evidence, 3600),
              (evidence + '/source.config.json', nonce, '/tmp/dms-pilot-v2-' + nonce, 3600),
              (evidence + '/source.config.json', nonce, evidence, 86400),
              (evidence + '/source.config.json', nonce, evidence + ';touch-test', 3600)]:
            c = config(); c['runtime_seconds'] = runtime
            with self.subTest(config_path=config_path, key=key, folder=folder, runtime=runtime), self.assertRaises(v2.source.Refusal):
                v2.source_launch_plan(c, config_path, key, folder, now=NOW)

    def test_source_plan_explicit_service_path_does_not_use_shell_or_global_environment(self):
        import os
        original_path = os.environ.get('PATH')
        nonce = 'c' * 32
        evidence = '/home/ubuntu/qa-evidence/dms-pilot-v2-' + nonce
        c = config(); c['runtime_seconds'] = 3600
        with patch.object(v2.source.subprocess, 'run', side_effect=AssertionError('NO SYSTEMD/AWS/SQL')):
            plan = v2.source_launch_plan(c, evidence + '/source.config.json', nonce, evidence, now=NOW)
        command = plan['commandForRootReview']
        self.assertEqual([arg for arg in command if arg.startswith('--property=Environment=')],
                         ['--property=Environment=PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'])
        self.assertEqual(os.environ.get('PATH'), original_path)
        self.assertEqual(command[-7:], ['/usr/bin/python3', '-B',
                         '/home/ubuntu/wt/back-dev/infrastructure/aws/mysql/dms_pilot_source.py',
                         'run', '--config', evidence + '/source.config.json', '--ack-isolated-synthetic-source'])
        self.assertFalse(any(arg.startswith(('--setenv=', '--property=EnvironmentFile=', '--property=PassEnvironment=')) for arg in command))
        self.assertNotIn('/bin/sh', command)
        self.assertNotIn('/bin/bash', command)


if __name__ == '__main__':
    unittest.main()
