#!/usr/bin/env python3
"""Offline validation and command planning only: no AWS, SQL, subprocess or systemd execution."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import dms_pilot_source as source

INSTANCE_PATTERN = r'^cc-mysql-v2-[a-z0-9]{8}$'
OLD_RUN = '56b3538248370bf5b52d1b881e07280f'
OLD_SEED = '3746dd145fe1da0a43b92003386b8892e011e7733262bc9f31a1f88fa4d06e07'
TABLES = ['pilot_identity','pilot_probe','b_child_cascade','b_child_setnull','b_lob','b_google_generated',
          'b_due_generated','b_phone_generated','b_wa_catalog','b_wa_queue','b_cdc_barrier','b_parent']
GENERATED = [('b_google_generated','ad_group_key'),('b_google_generated','network_key'),
             ('b_google_generated','device_key'),('b_due_generated','due_at'),('b_phone_generated','active_phone_key')]
RESOURCE_NAMES = {'PilotSourceSecret','PilotTargetSecret','DmsSecretAccessRole','DmsSecurityGroup',
 'SecretsEndpointSecurityGroup','DmsToSource','DmsToTarget','TargetFromDms','DmsToSecretsEndpoint',
 'SecretsEndpointFromDms','SecretsManagerVpcEndpoint','DmsSubnetGroup','ReplicationInstance',
 'PilotSourceCertificate','RdsTargetCertificate','SourceEndpoint','TargetEndpoint','PilotTask',
 'PilotLogGroup','DmsCloudWatchLogsRole'}
GROUP_ARN = 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:dms-tasks-${PilotV2Identifier}'


def logs_policy():
    return {'Version':'2012-10-17','Statement':[
     {'Sid':'DescribeLogGroups','Effect':'Allow','Action':['logs:DescribeLogGroups'],'Resource':'*'},
     {'Sid':'OwnPilotGroup','Effect':'Allow','Action':['logs:DescribeLogStreams','logs:CreateLogGroup'],
      'Resource':[{'Fn::Sub':GROUP_ARN},{'Fn::Sub':GROUP_ARN+':*'}]},
     {'Sid':'OwnPilotTaskStreams','Effect':'Allow','Action':['logs:CreateLogStream','logs:PutLogEvents'],
      'Resource':{'Fn::Sub':GROUP_ARN+':log-stream:dms-task-*'}}]}


def validate_template(template):
    errors=[]
    def need(ok,code):
        if not ok: errors.append(code)
    r=template.get('Resources',{});p=lambda n:r.get(n,{}).get('Properties',{})
    ref=lambda n:{'Ref':n};att=lambda n,a:{'Fn::GetAtt':[n,a]}
    need(set(r)==RESOURCE_NAMES,'resource_scope')
    for name,resource in r.items():
        tags=resource.get('Properties',{}).get('Tags')
        if tags is not None:
            values={tag.get('Key'):tag.get('Value') for tag in tags}
            need(values.get('purpose')=='mysql-synthetic-pilot' and values.get('pilot-version')=='v2',
                 'source_compatible_pilot_tags_'+name)
    need(set(x.get('Type') for x in r.values()) <= {'AWS::IAM::Role','AWS::SecretsManager::Secret',
     'AWS::EC2::SecurityGroup','AWS::EC2::SecurityGroupEgress','AWS::EC2::SecurityGroupIngress',
     'AWS::EC2::VPCEndpoint','AWS::DMS::ReplicationSubnetGroup','AWS::DMS::ReplicationInstance',
     'AWS::DMS::Certificate','AWS::DMS::Endpoint','AWS::DMS::ReplicationTask','AWS::Logs::LogGroup'},'resource_types')
    params=template.get('Parameters',{})
    need(params.get('PilotV2Identifier',{}).get('AllowedPattern')==INSTANCE_PATTERN,'own_identifier_pattern')
    need(params.get('CreatePilotTask',{}).get('Default')=='false' and r.get('PilotTask',{}).get('Condition')=='CreateTask','task_opt_in')
    need(template.get('Conditions',{}).get('CreateTask')=={'Fn::Equals':[ref('CreatePilotTask'),'true']}
         and template.get('Rules',{}).get('TaskRequiresSyntheticIdentity',{}).get('RuleCondition')=={'Fn::Equals':[ref('CreatePilotTask'),'true']},'task_condition')
    for name,value in [('OldPilotDeletionConfirmed','deleted-and-verified'),('CloudWatchLogsRoleAbsenceConfirmed','absent-and-verified'),('ExistingVpcRoleConfirmed','reviewed-and-verified')]:
        need(params.get(name,{}).get('Default')=='no','preflight_default_'+name)
        rules=template.get('Rules',{}).get('FreshPilotInfrastructureOnly',{}).get('Assertions',[])
        need(any(x.get('Assert')=={'Fn::Equals':[ref(name),value]} for x in rules),'preflight_rule_'+name)
    inst=p('ReplicationInstance')
    need(inst.get('ReplicationInstanceClass')=='dms.r6i.large' and inst.get('AllocatedStorage')==50
         and inst.get('MultiAZ') is False and inst.get('PubliclyAccessible') is False,'private_bounded_instance')
    need(inst.get('ReplicationInstanceIdentifier')==ref('PilotV2Identifier') and inst.get('ResourceIdentifier')==ref('PilotV2Identifier'),'instance_names')
    need(inst.get('ReplicationSubnetGroupIdentifier')==ref('DmsSubnetGroup') and p('DmsSubnetGroup').get('SubnetIds')==ref('PrivateSubnetIds'),'existing_subnets')
    need(set(r.get('ReplicationInstance',{}).get('DependsOn',[])) >= {'PilotLogGroup','DmsCloudWatchLogsRole'},'logs_before_instance')
    need('DmsVpcRole' not in r,'no_shared_vpc_role_modification')
    group=p('PilotLogGroup');role=p('DmsCloudWatchLogsRole')
    need(group.get('LogGroupName')=={'Fn::Sub':'dms-tasks-${PilotV2Identifier}'} and group.get('RetentionInDays')==1
         and r.get('PilotLogGroup',{}).get('DeletionPolicy')=='Delete' and r.get('PilotLogGroup',{}).get('UpdateReplacePolicy')=='Delete','own_log_group_retention_delete')
    need(role.get('RoleName')=='dms-cloudwatch-logs-role' and role.get('AssumeRolePolicyDocument')=={'Version':'2012-10-17','Statement':[
      {'Effect':'Allow','Principal':{'Service':'dms.amazonaws.com'},'Action':'sts:AssumeRole',
       'Condition':{'StringEquals':{'aws:SourceAccount':ref('AWS::AccountId')}}}]},'logs_service_trust')
    need(role.get('Policies')==[{'PolicyName':'WriteOwnSyntheticPilotLogs','PolicyDocument':logs_policy()}]
         and not role.get('ManagedPolicyArns') and not role.get('PermissionsBoundary'),'minimum_logs_policy')
    secrets=[ref('PilotSourceSecret'),ref('PilotTargetSecret')]
    need(p('DmsSecretAccessRole').get('Policies')==[{'PolicyName':'ReadOwnPilotSecrets','PolicyDocument':{'Version':'2012-10-17','Statement':[
      {'Effect':'Allow','Action':['secretsmanager:GetSecretValue'],'Resource':secrets}]}}],'own_secret_policy')
    need(p('DmsSecretAccessRole').get('AssumeRolePolicyDocument',{}).get('Statement')==[{'Effect':'Allow','Principal':{'Service':{'Fn::Sub':'dms.${AWS::Region}.amazonaws.com'}},'Action':'sts:AssumeRole'}],'regional_secret_principal')
    for name in ['DmsSecurityGroup','SecretsEndpointSecurityGroup']:
        need(p(name).get('SecurityGroupEgress')==[{'IpProtocol':'tcp','FromPort':9,'ToPort':9,'CidrIp':'127.0.0.1/32','Description':'Suppress default allow-all outbound; loopback discard only'}]
             and not p(name).get('SecurityGroupIngress'),'no_open_group_'+name)
    need(p('DmsToSource').get('CidrIp')=='172.26.0.110/32' and p('DmsToSource').get('FromPort')==p('DmsToSource').get('ToPort')==23306,'isolated_source_port')
    need(p('DmsToTarget').get('DestinationSecurityGroupId')==ref('TargetRdsSecurityGroupId') and p('DmsToTarget').get('FromPort')==p('DmsToTarget').get('ToPort')==3306,'target_egress')
    need(p('TargetFromDms').get('SourceSecurityGroupId')==att('DmsSecurityGroup','GroupId') and p('TargetFromDms').get('GroupId')==ref('TargetRdsSecurityGroupId')
         and p('TargetFromDms').get('FromPort')==p('TargetFromDms').get('ToPort')==3306,'target_ingress')
    for name,key,dest in [('DmsToSecretsEndpoint','DestinationSecurityGroupId',att('SecretsEndpointSecurityGroup','GroupId')),('SecretsEndpointFromDms','SourceSecurityGroupId',att('DmsSecurityGroup','GroupId'))]:
        need(p(name).get(key)==dest and p(name).get('FromPort')==p(name).get('ToPort')==443,'private_https_'+name)
    for name in ['DmsToSource','DmsToTarget','DmsToSecretsEndpoint']:
        need(p(name).get('GroupId')==att('DmsSecurityGroup','GroupId') and p(name).get('IpProtocol')=='tcp','own_egress_group_'+name)
    need(p('SecretsEndpointFromDms').get('GroupId')==att('SecretsEndpointSecurityGroup','GroupId')
         and p('SecretsEndpointFromDms').get('IpProtocol')=='tcp','own_secret_ingress_group')
    vpce=p('SecretsManagerVpcEndpoint')
    need(vpce.get('VpcEndpointType')=='Interface' and vpce.get('PrivateDnsEnabled') is True and vpce.get('SubnetIds')==ref('PrivateSubnetIds')
         and vpce.get('ServiceName')=={'Fn::Sub':'com.amazonaws.${AWS::Region}.secretsmanager'},'private_secret_endpoint')
    need(vpce.get('PolicyDocument',{}).get('Statement')==[{'Effect':'Allow','Principal':{'AWS':att('DmsSecretAccessRole','Arn')},'Action':['secretsmanager:GetSecretValue'],'Resource':secrets}],'private_secret_endpoint_policy')
    for name,secret,cert,kind in [('SourceEndpoint','PilotSourceSecret','PilotSourceCertificate','source'),('TargetEndpoint','PilotTargetSecret','RdsTargetCertificate','target')]:
        endpoint=p(name)
        need(endpoint.get('SslMode')=='verify-full' and endpoint.get('EndpointType')==kind and endpoint.get('EngineName')=='mysql'
             and endpoint.get('CertificateArn')==ref(cert) and not any(k in endpoint for k in ['UserName','Password','ServerName','Port']),'strict_tls_'+name)
        need(endpoint.get('MySqlSettings')=={'SecretsManagerSecretId':ref(secret),'SecretsManagerAccessRoleArn':att('DmsSecretAccessRole','Arn')},'secret_auth_'+name)
        prefix='Initstmt=SET FOREIGN_KEY_CHECKS=1;' if kind=='target' else ''
        private_dns={'Fn::Select':[1,{'Fn::Split':[':',{'Fn::Select':[0,att('SecretsManagerVpcEndpoint','DnsEntries')]}]}]}
        need(endpoint.get('ExtraConnectionAttributes')=={'Fn::Sub':[prefix+'secretsManagerEndpointOverride=${SecretsManagerEndpointDns};',{'SecretsManagerEndpointDns':private_dns}]},'private_dns_fk_'+name)
    task=p('PilotTask')
    need(task.get('MigrationType')=='cdc' and task.get('CdcStartPosition')==ref('CdcStartPosition'),'native_seed_cdc_only')
    try:
        mappings=json.loads(task.get('TableMappings','{}'));settings=json.loads(task.get('ReplicationTaskSettings','{}'))
        selections=[x for x in mappings['rules'] if x['rule-type']=='selection'];transform=[x for x in mappings['rules'] if x['rule-type']=='transformation']
        need(len(selections)==12 and [x['object-locator'] for x in selections]==[{'schema-name':'cc_dms_pilot','table-name':n} for n in TABLES]
             and all(x.get('rule-action')=='include' for x in selections),'exact_twelve_tables')
        need(len(mappings['rules'])==17 and len(transform)==5 and [(x['object-locator']['table-name'],x['object-locator']['column-name']) for x in transform]==GENERATED
             and all(x.get('rule-action')=='remove-column' and x.get('rule-target')=='column' and x['object-locator'].get('schema-name')=='cc_dms_pilot' for x in transform),'exact_generated_exclusions')
        need(settings.get('Logging')=={'EnableLogging':True,'LogComponents':[{'Id':n,'Severity':'LOGGER_SEVERITY_INFO'} for n in ['SOURCE_CAPTURE','TARGET_APPLY','TASK_MANAGER']]},'diagnostic_logging')
        need(settings.get('TargetMetadata')=={'SupportLobs':True,'FullLobMode':True,'LobChunkSize':64,'LimitedSizeLobMode':False,'InlineLobMaxSize':0,'BatchApplyEnabled':False},'full_lob_no_batch')
        need(settings.get('ControlTablesSettings')=={'ControlSchema':'cc_dms_pilot'} and settings.get('FullLoadSettings')=={'TargetTablePrepMode':'DO_NOTHING'},'native_seed_preserved')
        need(settings.get('ValidationSettings')=={'EnableValidation':True,'SkipLobColumns':False,'ValidationPartialLobSize':0},'full_validation')
        need(all(settings.get('ErrorBehavior',{}).get(k)=='STOP_TASK' for k in ['DataErrorPolicy','DataTruncationErrorPolicy','TableErrorPolicy','ApplyErrorInsertPolicy','ApplyErrorUpdatePolicy','ApplyErrorDeletePolicy','DataErrorEscalationPolicy','ApplyErrorEscalationPolicy','TableErrorEscalationPolicy']) and settings['ErrorBehavior'].get('FullLoadIgnoreConflicts') is False and settings['ErrorBehavior'].get('FailOnNoTablesCaptured') is True,'stop_on_data_errors')
    except (ValueError,TypeError,KeyError): errors.append('task_json_invalid')
    assertions=template.get('Rules',{}).get('TaskRequiresSyntheticIdentity',{}).get('Assertions',[])
    for name in ['SourceRunId','NativeSeedSha256','CdcStartPosition']:
        need(params.get(name,{}).get('Default')=='PENDING' and any(x.get('Assert')=={'Fn::Not':[{'Fn::Equals':[ref(name),'PENDING']}]} for x in assertions),'fresh_receipt_'+name)
    for name,value in [('SourceRunId',OLD_RUN),('NativeSeedSha256',OLD_SEED)]:
        need(any(x.get('Assert')=={'Fn::Not':[{'Fn::Equals':[ref(name),value]}]} for x in assertions),'reject_v1_'+name)
    need(template.get('Metadata',{}).get('SyntheticNativeSeedCdc',{}).get('ClinicalCopyAuthorized') is False,'clinical_gate_closed')
    return sorted(set(errors))


def source_launch_plan(config, config_path, nonce, evidence_dir, now=None):
    source.validate_config(config,now=now)
    source.require(re.fullmatch(r'[0-9a-f]{32}',nonce or ''),'v2_nonce_invalid')
    source.require(600<=config['runtime_seconds']<=7200,'v2_runtime_must_be_10min_to_2h')
    base=Path('/home/ubuntu/qa-evidence')
    evidence=Path(evidence_dir)
    source.require(evidence.parent==base and evidence.name=='dms-pilot-v2-'+nonce,'v2_evidence_path_invalid')
    source.require(Path(config_path)==evidence/'source.config.json','v2_config_path_invalid')
    unit='cc-dms-pilot-source-v2-'+nonce+'.service'
    script='/home/ubuntu/wt/back-dev/infrastructure/aws/mysql/dms_pilot_source.py'
    properties=['Type=exec','User=ubuntu','Group=ubuntu','UMask=0077','Restart=no','KillMode=mixed','SendSIGKILL=yes',
      'RuntimeMaxSec='+str(config['runtime_seconds']+600),'TimeoutStopSec=90','NoNewPrivileges=yes','PrivateTmp=no',
      'WorkingDirectory=/home/ubuntu','StandardInput=null','StandardOutput=append:'+str(evidence/'supervisor-stdout.jsonl'),
      'StandardError=append:'+str(evidence/'supervisor-stderr.log')]
    command=['/usr/bin/sudo','-n','/usr/bin/systemd-run','--system','--no-ask-password','--unit='+unit,
      '--description=Owned synthetic DMS V2 source']+['--property='+x for x in properties]+[
      '/usr/bin/python3','-B',script,'run','--config',str(config_path),'--ack-isolated-synthetic-source']
    return {'schema':'clinicaclick-dms-v2-source-launch-plan/1','unit':unit,'commandForRootReview':command,
      'executeAutomatically':False,'awsCallsPerformed':False,'systemdInvoked':False,'sourceStarted':False,
      'requiresBeforeExecution':['V1 deletion verified; no23306 listener; V2 firewall allows only new DMS IP.',
       'Create fresh evidence directory as ubuntu0700 and config/stdout/stderr files0600, regular/nlink1/no symlinks; never truncate prior evidence.',
       'Refresh config stack/secret/IP/firewall review and validate source SHA; unit auth must independently succeed.',
       'Check installed systemd supports Type=exec and append: output; do not fall back to a scope, pipe or PTY.'],
      'sourceSha256':hashlib.sha256(Path(__file__).with_name('dms_pilot_source.py').read_bytes()).hexdigest(),
      'configSha256':hashlib.sha256(json.dumps(config,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
      'readiness':'Unit active/Type=exec is not source READY. Require private ready.json + owned SQL metadata/TLS independently.',
      'inspectCommands':[['/usr/bin/systemctl','show',unit,'--property=MainPID,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,RuntimeMaxUSec,TimeoutStopUSec'],
       ['/usr/bin/journalctl','--no-pager','--unit='+unit,'--output=short-iso']],
      'stopCommandForRootReview':['/usr/bin/sudo','-n','/usr/bin/systemctl','stop',unit],
      'noApplicationUnitsTouched':True,'restartPolicy':'none; failure requires a new reviewed source/seed, never silently reuse CDC coordinates',
      'activeRuntimeLimitSeconds':config['runtime_seconds']+600,'stopHardCapSeconds':90,
      'maximumServiceSecondsIncludingStop':config['runtime_seconds']+690,
      'clinicalCopyAuthorized':False,'allInheritedGatesPassed':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['check-template','source-plan'])
    parser.add_argument('--template',type=Path,default=Path(__file__).with_name('dms-pilot-v2.cloudformation.json'))
    parser.add_argument('--config',type=Path);parser.add_argument('--nonce');parser.add_argument('--evidence-dir')
    args=parser.parse_args()
    try:
        if args.command=='check-template':
            errors=validate_template(json.loads(args.template.read_text()))
            result={'staticErrors':errors,'awsAccountValidationPerformed':False,'deploymentAuthorized':False};status=2 if errors else 0
        else:
            source.require(args.config is not None,'v2_config_required');source.secure_file(args.config)
            result=source_launch_plan(json.loads(args.config.read_text()),args.config,args.nonce,args.evidence_dir);status=0
        print(json.dumps(result,indent=2));return status
    except (OSError,ValueError,TypeError,KeyError,source.Refusal):
        print(json.dumps({'status':'refused','code':'v2_plan_inputs_invalid','operationsPerformed':False}));return 2


if __name__=='__main__':raise SystemExit(main())
