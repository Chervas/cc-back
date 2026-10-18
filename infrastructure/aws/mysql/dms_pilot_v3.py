#!/usr/bin/env python3
"""V3 synthetic-only offline checks/planning. No AWS, SQL, subprocess or service execution."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re

import dms_pilot_v2 as v2

ROOT = Path(__file__).parent
L_KIB = 2048
L_BYTES = L_KIB * 1024
IDENTIFIER = r'^cc-mysql-v3-[0-9a-f]{8}$'
PINS = {
    'dms-pilot-v2.cloudformation.json': '3bda98943599787f6e7067270b0a16227b72400797d716bb7c5670d824afb6aa',
    'dms_pilot_v2.py': '52d7d25b2b14ae8de653782a6ac9782bfe897e1bb519f2ceb3fd00e1b3feb2ce',
    'dms_pilot_source.py': '4f3e9550718957abd53ad101c5313deabfc2f03d5d5d77457c0027cfe82d13e2',
    'dms_pilot_b_harness.cjs': '37aa39e698c5f295700285737069a7198d9b50fd14cc9375e0cb5b70e7b77d8e',
    'dms_pilot_b_fixture.cjs': 'c4a8165d5cd1973be7b5e1d9c7e2f08f171daa03e6b4bf783d9c915abaf2b97e',
    'dms_task_start_preflight.py': 'a0d375f389442abd6f4805c9d4d6abee0d0985eeea4c9b019d1bd4bfcdb26853',
}
NEW_RESOURCES = {'DmsVpcRole', 'LogsEndpointSecurityGroup', 'DmsToLogsEndpoint',
                 'LogsEndpointFromDms', 'LogsVpcEndpoint'}
NEW_CONFIRMATIONS = ['DmsVpcRoleAbsenceConfirmed', 'LogsVpcEndpointAbsenceConfirmed',
                     'ForeignVpcConsumersAbsenceConfirmed']
V2_RUN = 'b56bc368b3285dfdbfdebb575e71153f'
V2_SEED = '1b82cdc0df20a9f7e7f8f8fe558870d5165863913179b9030c0b3fe7cd43ed73'
LIMITED = {'SupportLobs': True, 'FullLobMode': False, 'LimitedSizeLobMode': True,
           'LobMaxSize': L_KIB, 'InlineLobMaxSize': 0, 'BatchApplyEnabled': False}
REF = lambda name: {'Ref': name}
ATT = lambda name, attribute: {'Fn::GetAtt': [name, attribute]}


def rename(value, before='v3', after='v2'):
    if isinstance(value, str):
        if '-----BEGIN CERTIFICATE-----' in value:
            return value
        if value == before:
            return after
        return (value.replace('Pilot' + before.upper() + 'Identifier', 'Pilot' + after.upper() + 'Identifier')
                .replace('-' + before + '-', '-' + after + '-').replace('-' + before + '/', '-' + after + '/')
                .replace(' ' + before.upper(), ' ' + after.upper()))
    if isinstance(value, list):
        return [rename(x, before, after) for x in value]
    if isinstance(value, dict):
        return {rename(k, before, after): rename(v, before, after) for k, v in value.items()}
    return value


def validate_template(template):
    errors = []
    def need(ok, code):
        if not ok:
            errors.append(code)
    for name, digest in PINS.items():
        need(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, 'frozen_input_' + name)
    baseline = json.loads((ROOT / 'dms-pilot-v2.cloudformation.json').read_text())
    need(set(template) == set(baseline) and
         template.get('AWSTemplateFormatVersion') == baseline['AWSTemplateFormatVersion'], 'no_template_macros_or_extra_scope')
    r = template.get('Resources', {})
    p = lambda name: r.get(name, {}).get('Properties', {})
    need(set(r) == v2.RESOURCE_NAMES | NEW_RESOURCES, 'exact_resource_scope')
    for name, kind in [('DmsVpcRole', 'AWS::IAM::Role'), ('LogsEndpointSecurityGroup', 'AWS::EC2::SecurityGroup'),
                       ('DmsToLogsEndpoint', 'AWS::EC2::SecurityGroupEgress'),
                       ('LogsEndpointFromDms', 'AWS::EC2::SecurityGroupIngress'),
                       ('LogsVpcEndpoint', 'AWS::EC2::VPCEndpoint')]:
        need(r.get(name, {}).get('Type') == kind and
             (kind in ['AWS::EC2::SecurityGroupEgress', 'AWS::EC2::SecurityGroupIngress'] or
              p(name).get('Tags') == p('DmsCloudWatchLogsRole').get('Tags')), 'new_resource_type_tags_' + name)
    params = template.get('Parameters', {})
    need(params.get('PilotV3Identifier', {}).get('AllowedPattern') == IDENTIFIER, 'v3_names')
    need('ExistingVpcRoleConfirmed' not in params, 'no_existing_vpc_role_reuse')
    confirms = template.get('Rules', {}).get('FreshPilotInfrastructureOnly', {}).get('Assertions', [])
    for name in NEW_CONFIRMATIONS:
        need(params.get(name, {}).get('Default') == 'no' and
             params[name].get('AllowedValues') == ['no', 'absent-and-verified'], 'absence_default_' + name)
        need(any(x.get('Assert') == {'Fn::Equals': [REF(name), 'absent-and-verified']} for x in confirms),
             'absence_rule_' + name)
    role = p('DmsVpcRole')
    need(role.get('RoleName') == 'dms-vpc-role' and
         role.get('AssumeRolePolicyDocument') == p('DmsCloudWatchLogsRole').get('AssumeRolePolicyDocument') and
         role.get('ManagedPolicyArns') == [{'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonDMSVPCManagementRole'}]
         and not role.get('Policies') and not role.get('PermissionsBoundary'), 'own_standard_vpc_role_only')
    need(r.get('DmsVpcRole', {}).get('DeletionPolicy') == 'Retain' and
         r.get('DmsVpcRole', {}).get('UpdateReplacePolicy') == 'Retain', 'vpc_role_explicit_identity_cleanup')
    need(role.get('Tags') == p('DmsCloudWatchLogsRole').get('Tags'), 'vpc_role_own_tags')
    need(r.get('DmsSubnetGroup', {}).get('DependsOn') == ['DmsVpcRole'], 'vpc_role_before_subnets')
    need(p('LogsEndpointSecurityGroup').get('SecurityGroupEgress') ==
         p('SecretsEndpointSecurityGroup').get('SecurityGroupEgress') and
         not p('LogsEndpointSecurityGroup').get('SecurityGroupIngress') and
         p('LogsEndpointSecurityGroup').get('VpcId') == REF('VpcId'), 'logs_sg_no_default_egress')
    for name, group, direction, peer in [
        ('DmsToLogsEndpoint', 'DmsSecurityGroup', 'DestinationSecurityGroupId', 'LogsEndpointSecurityGroup'),
        ('LogsEndpointFromDms', 'LogsEndpointSecurityGroup', 'SourceSecurityGroupId', 'DmsSecurityGroup')]:
        need(p(name) == {'GroupId': ATT(group, 'GroupId'), 'IpProtocol': 'tcp', 'FromPort': 443,
                         'ToPort': 443, direction: ATT(peer, 'GroupId')}, 'private_logs_443_' + name)
    endpoint = p('LogsVpcEndpoint')
    need(endpoint.get('VpcId') == REF('VpcId') and endpoint.get('VpcEndpointType') == 'Interface' and
         endpoint.get('ServiceName') == {'Fn::Sub': 'com.amazonaws.${AWS::Region}.logs'} and
         endpoint.get('PrivateDnsEnabled') is True and endpoint.get('SubnetIds') == REF('PrivateSubnetIds') and
         endpoint.get('SecurityGroupIds') == [ATT('LogsEndpointSecurityGroup', 'GroupId')], 'own_logs_vpce')
    policy = rename(v2.logs_policy(), 'v2', 'v3')
    for statement in policy['Statement']:
        statement['Principal'] = {'AWS': ATT('DmsCloudWatchLogsRole', 'Arn')}
    need(endpoint.get('PolicyDocument') == policy, 'logs_vpce_own_principal_scope')
    for name in ['ReplicationInstance', 'PilotTask']:
        need(set(r.get(name, {}).get('DependsOn', [])) >=
             {'LogsVpcEndpoint', 'DmsToLogsEndpoint', 'LogsEndpointFromDms'}, 'logs_before_' + name)
    assertions = template.get('Rules', {}).get('TaskRequiresSyntheticIdentity', {}).get('Assertions', [])
    for name, value in [('SourceRunId', V2_RUN), ('NativeSeedSha256', V2_SEED)]:
        need(any(x.get('Assert') == {'Fn::Not': [{'Fn::Equals': [REF(name), value]}]} for x in assertions),
             'reject_v2_' + name)
    expected_task = [x['Assert'] for x in baseline['Rules']['TaskRequiresSyntheticIdentity']['Assertions']] + [
        {'Fn::Not': [{'Fn::Equals': [REF(name), value]}]} for name, value in [('SourceRunId', V2_RUN), ('NativeSeedSha256', V2_SEED)]]
    expected_fresh = [x['Assert'] for x in baseline['Rules']['FreshPilotInfrastructureOnly']['Assertions']
                      if x['Assert']['Fn::Equals'][0] != REF('ExistingVpcRoleConfirmed')] + [
        {'Fn::Equals': [REF(name), 'absent-and-verified']} for name in NEW_CONFIRMATIONS]
    need([x.get('Assert') for x in assertions] == expected_task and
         template.get('Rules', {}).get('TaskRequiresSyntheticIdentity', {}).get('RuleCondition') ==
         baseline['Rules']['TaskRequiresSyntheticIdentity']['RuleCondition'] and
         [x.get('Assert') for x in confirms] == expected_fresh and
         set(template.get('Rules', {}).get('FreshPilotInfrastructureOnly', {})) == {'Assertions'} and
         set(template.get('Rules', {})) == set(baseline['Rules']) and
         template.get('Conditions') == baseline['Conditions'], 'all_fresh_seed_idle_rules_preserved')
    try:
        settings = json.loads(p('PilotTask')['ReplicationTaskSettings'])
        need(settings.get('TargetMetadata') == LIMITED, 'limited_synthetic_lob_only')
        need(settings.get('ValidationSettings') == {'EnableValidation': True, 'SkipLobColumns': False,
             'ValidationPartialLobSize': L_KIB}, 'limited_validation_with_full_hash_external')
        # Project only explicitly reviewed deltas back to the frozen V2. All other
        # resources, mappings, TLS, STOP policies and settings remain byte-equivalent JSON.
        projected = rename(copy.deepcopy(template))
        pr = projected['Resources']
        for name in NEW_RESOURCES:
            pr.pop(name, None)
        pr['DmsSubnetGroup'].pop('DependsOn', None)
        for name in ['ReplicationInstance', 'PilotTask']:
            pr[name]['DependsOn'] = [x for x in pr[name]['DependsOn'] if x not in NEW_RESOURCES]
        baseline_settings = json.loads(baseline['Resources']['PilotTask']['Properties']['ReplicationTaskSettings'])
        settings['TargetMetadata'] = baseline_settings['TargetMetadata']
        settings['ValidationSettings'] = baseline_settings['ValidationSettings']
        pr['PilotTask']['Properties']['ReplicationTaskSettings'] = json.dumps(settings, separators=(',', ':'))
        need(pr == baseline['Resources'], 'unreviewed_legacy_resource_delta')
        for name in NEW_CONFIRMATIONS:
            projected['Parameters'].pop(name, None)
        projected['Parameters']['ExistingVpcRoleConfirmed'] = baseline['Parameters']['ExistingVpcRoleConfirmed']
        projected['Parameters']['PilotV2Identifier']['AllowedPattern'] = baseline['Parameters']['PilotV2Identifier']['AllowedPattern']
        need(projected['Parameters'] == baseline['Parameters'], 'unreviewed_parameter_delta')
        outputs = projected.get('Outputs', {})
        need(outputs.pop('LogsVpcEndpointId', None) == {'Value': REF('LogsVpcEndpoint')} and
             outputs.pop('PilotVpcRoleArn', None) == {'Value': ATT('DmsVpcRole', 'Arn')} and
             outputs == baseline['Outputs'], 'exact_output_scope')
        projected['Rules'] = baseline['Rules']
        # V2's existing security checks provide an additional independent static pass.
        errors.extend('v2_projection_' + e for e in v2.validate_template(projected))
    except (KeyError, TypeError, ValueError):
        errors.append('task_or_projection_invalid')
    metadata = template.get('Metadata', {})
    need(metadata.get('SyntheticNativeSeedCdc', {}).get('ClinicalCopyAuthorized') is False and
         metadata.get('SyntheticNativeSeedCdc', {}).get('AllInheritedGatesPassed') is False,
         'clinical_gate_closed')
    need(metadata.get('LimitedLobSyntheticOnly', {}).get('ActualClinicalMaximumMeasured') is False and
         metadata.get('LimitedLobSyntheticOnly', {}).get('IndependentFullHashRequired') is True,
         'no_real_lob_maximum_claim')
    return sorted(set(errors))


def boundary_cases():
    cases = [{'operation': operation, 'encoding': encoding, 'column': column, 'sourceBytes': size}
             for operation in ['INSERT', 'UPDATE'] for encoding in ['ASCII', 'UTF8_multibyte']
             for column in ['b_lob.document', 'b_lob.payload'] for size in [L_BYTES - 1, L_BYTES, L_BYTES + 1]]
    return [dict(case, rowId=1000 + index) for index, case in enumerate(cases)]


def assess_lob_case(case, observed, *, binding):
    """Validate a future bound synthetic receipt; never an aggregate pilot PASS."""
    require = v2.source.require
    require(case in boundary_cases(), 'v3_boundary_case_invalid')
    require(isinstance(binding, dict) and set(binding) == {'taskArn', 'sourceRunId', 'seedSha256'} and
            re.fullmatch(r'arn:aws:dms:eu-west-3:137819318729:task:cc-mysql-v3-[0-9a-f]{8}-cdc', binding.get('taskArn', '')) is not None and
            re.fullmatch('[0-9a-f]{32}', binding.get('sourceRunId', '')) is not None and
            binding['sourceRunId'] not in [v2.OLD_RUN, V2_RUN] and
            re.fullmatch('[0-9a-f]{64}', binding.get('seedSha256', '')) is not None and
            binding['seedSha256'] not in [v2.OLD_SEED, V2_SEED], 'v3_boundary_expected_binding_invalid')
    require(observed.get('binding') == binding, 'v3_boundary_actual_binding_mismatch')
    require(all(observed.get(k) == case[k] for k in case), 'v3_boundary_binding_invalid')
    require(observed.get('sourceBytesIndependentlyRead') is True and
            observed.get('sourceMutationCommitted') is True and
            re.fullmatch('[0-9a-f]{64}', observed.get('sourceFullSha256', '')) is not None,
            'v3_full_source_evidence_required')
    if case['sourceBytes'] > L_BYTES:
        cause = observed.get('stopCauseEvidence', {})
        case_sha = hashlib.sha256(json.dumps(case, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        require(isinstance(cause, dict) and cause.get('binding') == binding and
                cause.get('caseSha256') == case_sha and cause.get('table') == 'b_lob' and
                cause.get('column') == case['column'].split('.')[1] and cause.get('rowId') == case['rowId'] and
                cause.get('operation') == case['operation'] and cause.get('sourceBytes') == case['sourceBytes'] and
                cause.get('limitBytes') == L_BYTES and cause.get('cause') == 'LOB_SIZE_LIMIT_EXCEEDED' and
                cause.get('origin') == 'bound_task_cloudwatch_event' and
                re.fullmatch('[0-9a-f]{64}', cause.get('rawEventSha256', '')) is not None and
                isinstance(cause.get('eventTimestampMs'), int) and cause['eventTimestampMs'] > 0 and
                type(observed.get('caseStartedAtMs')) is int and type(observed.get('caseFinishedAtMs')) is int and
                0 < observed['caseStartedAtMs'] <= cause['eventTimestampMs'] <= observed['caseFinishedAtMs'] and
                observed['caseFinishedAtMs'] - observed['caseStartedAtMs'] <= 300000 and
                cause.get('logGroup') == 'dms-tasks-' + binding['taskArn'].split(':')[-1][:-4] and
                cause.get('logStream') == 'dms-task-' + binding['taskArn'].split(':')[-1] and
                observed.get('manualStopObserved') is False and observed.get('unrelatedFailureObserved') is False,
                'v3_oversize_lob_cause_not_attributed')
        require(observed.get('taskStopped') is True and observed.get('targetMutationAbsent') is True and
                observed.get('targetSnapshotIndependentlyRead') is True and
                re.fullmatch('[0-9a-f]{64}', observed.get('targetBeforeFullSha256', '')) is not None and
                observed.get('targetBeforeFullSha256') == observed.get('targetAfterFullSha256') and
                observed.get('truncationDetected') is False, 'v3_oversize_truncation_or_missing_rejection')
        return {'status': 'EXPECTED_OVERSIZE_REJECTION', 'pilotAccepted': False, 'stopAndReview': True}
    require(observed.get('targetBytesIndependentlyRead') is True and
            observed.get('targetBytes') == case['sourceBytes'] and
            observed.get('sourceFullSha256') == observed.get('targetFullSha256') and
            observed.get('taskStopped') is False and observed.get('validationFailures') == 0 and
            observed.get('suspendedTables') == 0 and observed.get('truncationDetected') is False,
            'v3_full_target_equality_required')
    return {'status': 'ONE_BOUNDARY_CASE_EQUAL', 'pilotAccepted': False,
            'allTwelveFullHashesAndCheckpointStillRequired': True}


def source_launch_plan(config, config_path, nonce, evidence_dir, now=None):
    for name, digest in PINS.items():
        v2.source.require(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, 'v3_frozen_input_changed')
    expected = '/home/ubuntu/qa-evidence/dms-pilot-v3-' + str(nonce)
    v2.source.require(str(evidence_dir) == expected and str(config_path) == expected + '/source.config.json',
                      'v3_source_plan_paths_invalid')
    old_path, old_evidence = str(config_path).replace('dms-pilot-v3-', 'dms-pilot-v2-'), expected.replace('dms-pilot-v3-', 'dms-pilot-v2-')
    plan = rename(v2.source_launch_plan(config, old_path, nonce, old_evidence, now=now), 'v2', 'v3')
    plan['requiresBeforeExecution'][0] = 'Fresh V1/V2 deletion, absent23306 listener, V3-only firewall and absent-only role/privateDNS preflight; do not alter current or previous runs.'
    plan['paidTeardownReview'] = {'state': 'PROPOSED_NOT_STARTED', 'atUtc': None,
                                'rootMustSetFreshFutureReviewBeforeCreation': True, 'automaticAwsDeletion': False}
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check-template'])
    parser.add_argument('--template', type=Path, default=ROOT / 'dms-pilot-v3.cloudformation.json')
    args = parser.parse_args()
    try:
        errors = validate_template(json.loads(args.template.read_text()))
    except (OSError, ValueError, TypeError):
        errors = ['v3_template_inputs_invalid']
    print(json.dumps({'staticErrors': errors, 'awsAccountValidationPerformed': False,
                      'deploymentAuthorized': False, 'operationsPerformed': False}, indent=2))
    return 2 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
