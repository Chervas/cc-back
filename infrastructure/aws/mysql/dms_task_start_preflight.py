#!/usr/bin/env python3
"""Read-only readiness for a synthetic DMS task. Actual Start remains manual VNC."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ACCOUNT = '137819318729'
REGION = 'eu-west-3'
STABLE = {'CREATE_COMPLETE', 'UPDATE_COMPLETE'}
READS = {('sts', 'get-caller-identity'), ('cloudformation', 'describe-stacks'),
         ('cloudformation', 'describe-stack-resource'), ('dms', 'describe-replication-tasks'),
         ('dms', 'describe-replication-instances'), ('dms', 'describe-endpoints'),
         ('dms', 'list-tags-for-resource')}


class Refusal(Exception):
    pass


def need(ok, code):
    if not ok:
        raise Refusal(code)


def validate_binding(b):
    fields = {'schema', 'aws_profile', 'account_id', 'region', 'stack_arn', 'logical_task_id',
              'task_arn', 'replication_instance_arn', 'source_endpoint_arn', 'target_endpoint_arn', 'expected_tags'}
    need(isinstance(b, dict) and set(b) == fields, 'dms_start_binding_fields_invalid')
    need(b['schema'] == 'clinicaclick-dms-vnc-start-binding/1' and b['account_id'] == ACCOUNT
         and b['region'] == REGION, 'dms_start_binding_account_or_region_invalid')
    need(isinstance(b['aws_profile'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', b['aws_profile']),
         'dms_start_explicit_profile_invalid')
    need(isinstance(b['stack_arn'], str) and re.fullmatch(
        r'arn:aws:cloudformation:eu-west-3:137819318729:stack/clinicaclick-mysql-dms-[A-Za-z0-9-]+/[a-f0-9-]{36}',
        b['stack_arn']), 'dms_start_stack_binding_invalid')
    need(isinstance(b['logical_task_id'], str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,100}', b['logical_task_id']),
         'dms_start_logical_id_invalid')
    for key, kind in [('task_arn', 'task'), ('replication_instance_arn', 'rep'),
                      ('source_endpoint_arn', 'endpoint'), ('target_endpoint_arn', 'endpoint')]:
        need(isinstance(b[key], str) and re.fullmatch(
            'arn:aws:dms:' + REGION + ':' + ACCOUNT + ':' + kind + r':[A-Za-z0-9-]{1,100}', b[key]),
             'dms_start_resource_binding_invalid')
    need(b['source_endpoint_arn'] != b['target_endpoint_arn'], 'dms_start_endpoints_not_separate')
    tags = b['expected_tags']
    need(isinstance(tags, dict) and tags.get('purpose') == 'mysql-synthetic-pilot'
         and tags.get('application') == 'clinicaclick' and isinstance(tags.get('pilot-version'), str)
         and re.fullmatch(r'v[0-9]{1,3}', tags['pilot-version']) and len(tags) <= 20,
         'dms_start_synthetic_tags_required')
    need(all(isinstance(k, str) and re.fullmatch(r'[A-Za-z0-9_.:/+=@-]{1,128}', k)
             and isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9_.:/+=@-]{1,256}', v)
             for k, v in tags.items()), 'dms_start_tag_binding_invalid')
    return b


def aws_read(b, service, operation, *args):
    validate_binding(b)
    need((service, operation) in READS, 'dms_start_non_read_operation_forbidden')
    command = ['aws', service, operation, *args, '--profile', b['aws_profile'], '--region', REGION,
               '--output', 'json', '--no-cli-pager']
    env = dict(os.environ, AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off')
    try:
        result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=15, check=True)
        need(len(result.stdout.encode()) <= 2 * 1024 * 1024, 'dms_start_response_too_large')
        value = json.loads(result.stdout)
        need(isinstance(value, dict), 'dms_start_response_invalid')
        return value
    except (OSError, ValueError, subprocess.SubprocessError):
        # Do not emit CLI stderr: it can contain resource details or credentials.
        raise Refusal('dms_start_aws_read_failed') from None


def check(b, *, aws=aws_read, now=lambda: dt.datetime.now(dt.timezone.utc)):
    validate_binding(b)
    identity = aws(b, 'sts', 'get-caller-identity')
    need(identity.get('Account') == ACCOUNT, 'dms_start_sts_account_mismatch')
    need(isinstance(identity.get('Arn'), str) and re.fullmatch(
        r'arn:aws:sts::137819318729:assumed-role/AWSReservedSSO_[A-Za-z0-9_+=,.@-]{1,128}/[A-Za-z0-9_+=,.@-]{2,64}',
        identity['Arn']), 'dms_start_assigned_sso_session_required')

    def stack():
        rows = aws(b, 'cloudformation', 'describe-stacks', '--stack-name', b['stack_arn']).get('Stacks')
        need(isinstance(rows, list) and len(rows) == 1 and rows[0].get('StackId') == b['stack_arn'],
             'dms_start_exact_stack_missing')
        need(rows[0].get('StackStatus') in STABLE, 'dms_start_stack_not_stable')
        return {k: rows[0].get(k) for k in ['StackId', 'StackStatus', 'CreationTime', 'LastUpdatedTime']}

    def resource():
        row = aws(b, 'cloudformation', 'describe-stack-resource', '--stack-name', b['stack_arn'],
                  '--logical-resource-id', b['logical_task_id']).get('StackResourceDetail')
        need(isinstance(row, dict) and row.get('StackId') == b['stack_arn']
             and row.get('LogicalResourceId') == b['logical_task_id']
             and row.get('ResourceType') == 'AWS::DMS::ReplicationTask'
             and row.get('PhysicalResourceId') == b['task_arn'], 'dms_start_task_not_owned_by_stack')
        need(row.get('ResourceStatus') in STABLE, 'dms_start_task_resource_not_stable')
        return {k: row.get(k) for k in ['PhysicalResourceId', 'ResourceStatus', 'LastUpdatedTimestamp']}

    def task():
        rows = aws(b, 'dms', 'describe-replication-tasks', '--filters',
                   'Name=replication-task-arn,Values=' + b['task_arn']).get('ReplicationTasks')
        need(isinstance(rows, list) and len(rows) == 1, 'dms_start_exact_task_missing')
        row = rows[0]
        need(all(row.get(actual) == b[expected] for actual, expected in [
            ('ReplicationTaskArn', 'task_arn'), ('ReplicationInstanceArn', 'replication_instance_arn'),
            ('SourceEndpointArn', 'source_endpoint_arn'), ('TargetEndpointArn', 'target_endpoint_arn')]),
             'dms_start_task_binding_mismatch')
        need(row.get('Status') == 'ready', 'dms_start_task_not_ready')

    initial_stack, initial_resource = stack(), resource()
    task()
    reps = aws(b, 'dms', 'describe-replication-instances', '--filters',
               'Name=replication-instance-arn,Values=' + b['replication_instance_arn']).get('ReplicationInstances')
    need(isinstance(reps, list) and len(reps) == 1
         and reps[0].get('ReplicationInstanceArn') == b['replication_instance_arn']
         and reps[0].get('ReplicationInstanceStatus') == 'available'
         and reps[0].get('PubliclyAccessible') is False, 'dms_start_private_instance_not_ready')
    arns = [b['task_arn'], b['replication_instance_arn']]
    for kind in ['source', 'target']:
        arn = b[kind + '_endpoint_arn']
        endpoints = aws(b, 'dms', 'describe-endpoints', '--filters', 'Name=endpoint-arn,Values=' + arn).get('Endpoints')
        need(isinstance(endpoints, list) and len(endpoints) == 1 and endpoints[0].get('EndpointArn') == arn
             and str(endpoints[0].get('EndpointType', '')).lower() == kind
             and endpoints[0].get('EngineName') == 'mysql' and endpoints[0].get('SslMode') == 'verify-full',
             'dms_start_endpoint_binding_or_tls_mismatch')
        arns.append(arn)
    for arn in arns:
        items = aws(b, 'dms', 'list-tags-for-resource', '--resource-arn', arn).get('TagList')
        need(isinstance(items, list) and all(isinstance(t, dict) and isinstance(t.get('Key'), str)
             and isinstance(t.get('Value'), str) and t.get('ResourceArn', arn) == arn for t in items),
             'dms_start_tags_unproven')
        tags = {t['Key']: t['Value'] for t in items}
        need(len(tags) == len(items) and all(tags.get(k) == v for k, v in b['expected_tags'].items()),
             'dms_start_resource_not_expected_synthetic_pilot')
    # Recheck immediately before the result. This remains an observation, not a lock
    # against later CloudFormation changes or a substitute for the manual Start.
    need(resource() == initial_resource, 'dms_start_task_resource_changed_during_check')
    task()
    need(stack() == initial_stack, 'dms_start_stack_changed_during_check')
    checked = now()
    need(checked.tzinfo is not None, 'dms_start_clock_timezone_required')
    return {'status': 'READY_FOR_VNC_START', 'checkedAt': checked.astimezone(dt.timezone.utc).isoformat(),
            'bindingSha256': hashlib.sha256(json.dumps(b, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'accountId': ACCOUNT, 'region': REGION, 'stackArn': b['stack_arn'], 'taskArn': b['task_arn'],
            'stackStatus': initial_stack['StackStatus'], 'taskResourceStatus': initial_resource['ResourceStatus'],
            'taskStatus': 'ready', 'automaticStartPerformed': False, 'awsWritesPerformed': False,
            'sqlPerformed': False, 'secretValuesRead': False, 'recheckImmediatelyBeforeVncStart': True}


def read_binding(file):
    before = file.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
         and stat.S_IMODE(before.st_mode) & 0o077 == 0 and before.st_size <= 65536,
         'dms_start_binding_file_not_private')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r') as stream:
        actual = os.fstat(stream.fileno())
        need((actual.st_dev, actual.st_ino, actual.st_size) == (before.st_dev, before.st_ino, before.st_size),
             'dms_start_binding_file_changed')
        value = json.load(stream)
    after = file.lstat()
    need((after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns) ==
         (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns), 'dms_start_binding_file_changed')
    return validate_binding(value)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(check(read_binding(args.binding)), sort_keys=True))
        return 0
    except Refusal as error:
        print(json.dumps({'status': 'REFUSED', 'code': str(error)}))
        return 2
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        print(json.dumps({'status': 'REFUSED', 'code': 'dms_start_inputs_or_response_invalid'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
