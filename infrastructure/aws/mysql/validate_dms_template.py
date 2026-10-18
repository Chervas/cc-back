#!/usr/bin/env python3
"""Static pilot safety checks. No AWS calls, secrets retrieval or SQL execution."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def validate(template, plan):
    errors = []

    def require(ok, code):
        if not ok:
            errors.append(code)

    r = template.get('Resources', {})
    allowed = {'AWS::IAM::Role', 'AWS::SecretsManager::Secret', 'AWS::EC2::SecurityGroup',
               'AWS::EC2::SecurityGroupEgress', 'AWS::EC2::SecurityGroupIngress',
               'AWS::EC2::VPCEndpoint', 'AWS::DMS::ReplicationSubnetGroup',
               'AWS::DMS::ReplicationInstance', 'AWS::DMS::Certificate',
               'AWS::DMS::Endpoint', 'AWS::DMS::ReplicationTask'}
    require(len(r) == 19 and all(v.get('Type') in allowed for v in r.values()), 'resource_scope_changed')
    p = lambda name: r.get(name, {}).get('Properties', {})
    ref = lambda name: {'Ref': name}
    att = lambda name, attr: {'Fn::GetAtt': [name, attr]}
    instance = p('ReplicationInstance')
    require(instance.get('ReplicationInstanceClass') == 'dms.r6i.large'
            and instance.get('AllocatedStorage') == 50 and instance.get('MultiAZ') is False
            and instance.get('PubliclyAccessible') is False, 'private_bounded_single_az_required')
    require(instance.get('ReplicationSubnetGroupIdentifier') == ref('DmsSubnetGroup')
            and p('DmsSubnetGroup').get('SubnetIds') == ref('PrivateSubnetIds'), 'existing_private_subnets_required')
    require('KmsKeyId' not in instance, 'default_aws_dms_encryption_key_expected')
    role = p('DmsVpcRole')
    require(role.get('RoleName') == 'dms-vpc-role'
            and r['DmsVpcRole'].get('DeletionPolicy') == 'Retain'
            and r['DmsVpcRole'].get('UpdateReplacePolicy') == 'Retain', 'shared_named_vpc_role_must_be_retained')
    require(role.get('ManagedPolicyArns') == [{'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonDMSVPCManagementRole'}], 'documented_vpc_policy_required')
    secret_refs = [ref('PilotSourceSecret'), ref('PilotTargetSecret')]
    policies = p('DmsSecretAccessRole').get('Policies', [])
    require(len(policies) == 1 and policies[0].get('PolicyDocument', {}).get('Statement') == [
        {'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue'], 'Resource': secret_refs}],
        'secret_role_must_read_only_owned_secrets')
    trust = p('DmsSecretAccessRole').get('AssumeRolePolicyDocument', {}).get('Statement', [])
    require(trust == [{'Effect': 'Allow', 'Principal': {'Service': {'Fn::Sub': 'dms.${AWS::Region}.amazonaws.com'}},
                       'Action': 'sts:AssumeRole'}], 'regional_dms_secret_principal_required')
    for name, port in [('PilotSourceSecret', 23306), ('PilotTargetSecret', 3306)]:
        secret = p(name); generator = secret.get('GenerateSecretString', {})
        require('SecretString' not in secret and generator.get('GenerateStringKey') == 'password'
                and generator.get('PasswordLength') == 32 and generator.get('ExcludePunctuation') is True,
                'generated_password_required_' + name)
        raw = generator.get('SecretStringTemplate', '')
        if isinstance(raw, dict):
            raw = raw.get('Fn::Sub', '')
        try:
            metadata = json.loads(raw)
        except (TypeError, ValueError):
            metadata = {}
        require(metadata.get('username') == 'cc_dms_pilot' and metadata.get('dbname') == 'cc_dms_pilot'
                and metadata.get('port') == port and 'password' not in metadata,
                'synthetic_secret_identity_required_' + name)
        require(metadata.get('host') == ('172.26.0.110' if port == 23306 else '${TargetRdsHostname}'),
                'synthetic_secret_host_required_' + name)
    for name, kind, secret, cert in [('SourceEndpoint', 'source', 'PilotSourceSecret', 'PilotSourceCertificate'),
                                    ('TargetEndpoint', 'target', 'PilotTargetSecret', 'RdsTargetCertificate')]:
        endpoint = p(name)
        require(endpoint.get('EndpointType') == kind and endpoint.get('EngineName') == 'mysql'
                and endpoint.get('SslMode') == 'verify-full' and endpoint.get('CertificateArn') == ref(cert),
                'strict_endpoint_tls_' + name)
        require(not any(key in endpoint for key in ('UserName', 'Password', 'ServerName', 'Port')),
                'secret_authentication_only_' + name)
        require(endpoint.get('MySqlSettings') == {'SecretsManagerSecretId': ref(secret),
                    'SecretsManagerAccessRoleArn': att('DmsSecretAccessRole', 'Arn')},
                'owned_endpoint_secret_only_' + name)
        private_dns = {'Fn::Select': [1, {'Fn::Split': [':', {'Fn::Select': [0,
                       att('SecretsManagerVpcEndpoint', 'DnsEntries')]}]}]}
        prefix = 'Initstmt=SET FOREIGN_KEY_CHECKS=0;' if kind == 'target' else ''
        require(endpoint.get('ExtraConnectionAttributes') == {'Fn::Sub': [
                    prefix + 'secretsManagerEndpointOverride=${SecretsManagerEndpointDns};',
                    {'SecretsManagerEndpointDns': private_dns}]}, 'private_secret_dns_override_' + name)
    ca = p('RdsTargetCertificate').get('CertificatePem', '')
    require(isinstance(ca, str) and ca.count('-----BEGIN CERTIFICATE-----') == 3
            and 'PRIVATE KEY' not in ca and hashlib.sha256(ca.encode()).hexdigest()
            == template.get('Metadata', {}).get('PublicRdsCaSha256'), 'public_rds_ca_bundle_integrity')
    require(p('PilotSourceCertificate').get('CertificatePem') == ref('PilotSourceCaPem'), 'pilot_public_ca_parameter_required')
    for name in ('DmsSecurityGroup', 'SecretsEndpointSecurityGroup'):
        rules = p(name).get('SecurityGroupEgress', [])
        require(len(rules) == 1 and {k: rules[0].get(k) for k in ('IpProtocol', 'FromPort', 'ToPort', 'CidrIp')}
                == {'IpProtocol': 'tcp', 'FromPort': 9, 'ToPort': 9, 'CidrIp': '127.0.0.1/32'},
                'no_default_external_egress_' + name)
    source = p('DmsToSource')
    require(source.get('CidrIp') == '172.26.0.110/32' and source.get('FromPort') == source.get('ToPort') == 23306,
            'source_must_be_isolated_pilot_port')
    require(p('DmsToTarget').get('DestinationSecurityGroupId') == ref('TargetRdsSecurityGroupId')
            and p('DmsToTarget').get('FromPort') == p('DmsToTarget').get('ToPort') == 3306,
            'target_egress_scope')
    require(p('TargetFromDms').get('GroupId') == ref('TargetRdsSecurityGroupId')
            and p('TargetFromDms').get('SourceSecurityGroupId') == att('DmsSecurityGroup', 'GroupId')
            and p('TargetFromDms').get('FromPort') == p('TargetFromDms').get('ToPort') == 3306,
            'target_ingress_scope')
    for name, dest_key, dest in [('DmsToSecretsEndpoint', 'DestinationSecurityGroupId', att('SecretsEndpointSecurityGroup', 'GroupId')),
                                ('SecretsEndpointFromDms', 'SourceSecurityGroupId', att('DmsSecurityGroup', 'GroupId'))]:
        require(p(name).get(dest_key) == dest and p(name).get('FromPort') == p(name).get('ToPort') == 443,
                'private_secrets_https_scope_' + name)
    endpoint = p('SecretsManagerVpcEndpoint')
    require(endpoint.get('VpcEndpointType') == 'Interface' and endpoint.get('PrivateDnsEnabled') is True
            and endpoint.get('SubnetIds') == ref('PrivateSubnetIds')
            and endpoint.get('ServiceName') == {'Fn::Sub': 'com.amazonaws.${AWS::Region}.secretsmanager'},
            'private_secrets_endpoint_required')
    require(endpoint.get('PolicyDocument', {}).get('Statement') == [{'Effect': 'Allow',
            'Principal': {'AWS': att('DmsSecretAccessRole', 'Arn')},
            'Action': ['secretsmanager:GetSecretValue'], 'Resource': secret_refs}], 'private_endpoint_policy_scope')
    task = p('PilotTask')
    require(r.get('PilotTask', {}).get('Condition') == 'CreateTask'
            and template.get('Parameters', {}).get('CreatePilotTask', {}).get('Default') == 'false',
            'task_creation_must_be_opt_in_and_idle')
    try:
        require(json.loads(task.get('TableMappings', '{}')) == plan['table_mappings'], 'synthetic_mappings_drift')
        require(json.loads(task.get('ReplicationTaskSettings', '{}')) == plan['task_settings'], 'task_settings_drift')
    except (ValueError, TypeError, KeyError):
        errors.append('task_json_invalid')
    for name, output in template.get('Outputs', {}).items():
        require(isinstance(output.get('Value'), dict) and set(output['Value']) <= {'Ref', 'Fn::GetAtt'},
                'no_secret_values_in_outputs_' + name)
    return sorted(set(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', type=Path, default=Path(__file__).with_name('dms-pilot.cloudformation.json'))
    parser.add_argument('--plan', type=Path, default=Path(__file__).with_name('dms-pilot.plan.json'))
    args = parser.parse_args()
    try:
        errors = validate(json.loads(args.template.read_text()), json.loads(args.plan.read_text()))
    except (OSError, ValueError, TypeError, KeyError):
        errors = ['template_input_invalid']
    print(json.dumps({'static_safety_errors': errors, 'aws_account_validation_performed': False,
                      'deployment_authorized': False}, indent=2))
    return 2 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
