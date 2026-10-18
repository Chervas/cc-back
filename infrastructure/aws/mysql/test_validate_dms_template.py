import copy
import json
import re
import unittest
from pathlib import Path

from validate_dms_template import validate


class TemplateTests(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).parent
        self.template = json.loads((base / 'dms-pilot.cloudformation.json').read_text())
        self.plan = json.loads((base / 'dms-pilot.plan.json').read_text())

    def test_review_template_satisfies_static_safety_contract(self):
        self.assertEqual(validate(self.template, self.plan), [])

    def test_cloudformation_input_patterns(self):
        params = self.template['Parameters']
        for version in ('3.5.4', '3.5.10', '3.6.1', '3.10.0'):
            self.assertIsNotNone(re.fullmatch(params['DmsEngineVersion']['AllowedPattern'], version))
        for version in ('3.4.7', '3.5.3', '3.5', '4.0.0'):
            self.assertIsNone(re.fullmatch(params['DmsEngineVersion']['AllowedPattern'], version))
        self.assertIsNotNone(re.fullmatch(params['TargetRdsHostname']['AllowedPattern'],
                                         'fictional.example.eu-west-3.rds.amazonaws.com'))
        self.assertIsNone(re.fullmatch(params['TargetRdsHostname']['AllowedPattern'], '172.31.64.185'))
        self.assertIsNone(re.fullmatch(params['PilotSourceCaPem']['AllowedPattern'],
                                      '-----BEGIN PRIVATE KEY-----\nRklDVElUSU9VUw==\n-----END PRIVATE KEY-----\n'))
        self.assertEqual(params['DmsEngineVersion']['Default'], '3.6.1')

    def test_network_iam_and_data_scope_mutations_are_rejected(self):
        cases = [
            lambda r: r['ReplicationInstance']['Properties'].update(PubliclyAccessible=True),
            lambda r: r['ReplicationInstance']['Properties'].update(MultiAZ=True),
            lambda r: r['DmsToSource']['Properties'].update(FromPort=13306, ToPort=13306),
            lambda r: r['DmsToSource']['Properties'].update(CidrIp='0.0.0.0/0'),
            lambda r: r['DmsSecretAccessRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'][0].update(Resource='*'),
            lambda r: r['DmsVpcRole'].update(DeletionPolicy='Delete'),
            lambda r: r['DmsSubnetGroup'].pop('DependsOn'),
            lambda r: r['PilotSourceSecret']['Properties'].update(SecretString='fixture-only'),
            lambda r: r['PilotSourceSecret']['Properties']['GenerateSecretString'].update(PasswordLength=8),
            lambda r: r['SourceEndpoint']['Properties'].update(SslMode='none'),
            lambda r: r['TargetEndpoint']['Properties'].update(SslMode='verify-ca'),
            lambda r: r['TargetEndpoint']['Properties'].update(UserName='ccadmin'),
            lambda r: r['SourceEndpoint']['Properties'].pop('ExtraConnectionAttributes'),
            lambda r: r['TargetEndpoint']['Properties'].update(ExtraConnectionAttributes='Initstmt=SET FOREIGN_KEY_CHECKS=0;'),
            lambda r: r['PilotTask']['Properties'].update(TableMappings='{"rules":[]}'),
            lambda r: r['SecretsManagerVpcEndpoint']['Properties'].update(PrivateDnsEnabled=False),
            lambda r: r['DmsSecurityGroup']['Properties'].update(SecurityGroupEgress=[]),
        ]
        for index, mutate in enumerate(cases):
            with self.subTest(index=index):
                template = copy.deepcopy(self.template); mutate(template['Resources'])
                self.assertNotEqual(validate(template, self.plan), [])


if __name__ == '__main__':
    unittest.main()
