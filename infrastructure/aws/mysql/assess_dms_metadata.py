#!/usr/bin/env python3
"""Offline assessment only. Never connects to AWS/SQL or authorizes a cutover."""
import argparse
import datetime as dt
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


# MySQL TEXT/TINYTEXT map to WSTRING, whereas these types use DMS LOB handling.
LOB_TYPES = {'json', 'mediumtext', 'longtext', 'mediumblob', 'longblob', 'blob',
             'geometry', 'point', 'linestring', 'polygon', 'multipoint',
             'multilinestring', 'multipolygon', 'geometrycollection'}
REQUIRED_CHECKS = {
    'tls_both_endpoints_verify_full', 'tls_wrong_ca_rejected',
    'tls_wrong_hostname_rejected', 'tls_12_and_authentication_plugin_supported',
    'source_forward_isolated_no_plaintext_remote_hop',
    'target_local_infile_and_dedicated_user_grants',
    'full_lob_json_text_roundtrip_and_full_validation',
    'lob_nullability_restore_timed_under_cdc_fence',
    'fk_cascades_and_set_null_during_full_load_cached_and_cdc',
    'generated_columns_omitted_and_target_recomputed',
    'whatsapp_catalog_triggers_restore_and_reject_invalid_writes',
    'whatsapp_queue_inflight_ack_and_replay_without_external_sends',
    'native_schema_indexes_enum_precision_defaults_preserved',
    'connection_loss_restart_and_resume_without_gap_or_duplicates',
    'final_marker_applied_after_all_source_writers_fenced',
    'rollback_before_target_writers_enabled',
    'forward_recovery_after_target_writers_enabled',
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def has_inline_credentials(value):
    if isinstance(value, dict):
        return any(k.lower() in {'password', 'masteruserpassword', 'secretaccesskey',
                                 'accesskeyid', 'sessiontoken'} or has_inline_credentials(v)
                   for k, v in value.items())
    return isinstance(value, list) and any(has_inline_credentials(v) for v in value)


def assess(metadata, plan, receipt=None, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    errors = []

    def require(ok, code):
        if not ok:
            errors.append(code)

    require(metadata.get('schema') == 'dms-source-metadata/1', 'metadata_schema_invalid')
    require(plan.get('schema') == 'clinicaclick-dms-pilot/1', 'plan_schema_invalid')
    require(not has_inline_credentials(plan), 'inline_credentials_forbidden')
    clinical = plan.get('clinical_copy', {})
    require(clinical.get('status') == 'blocked_pending_synthetic_rehearsal'
            and clinical.get('start_authorized') is False and clinical.get('cutover_authorized') is False,
            'clinical_copy_must_remain_blocked')
    tables, columns, indexes = (metadata.get(k, []) for k in ('tables', 'columns', 'indexes'))
    names = {t.get('table') for t in tables}
    require(bool(names) and len(names) == len(tables), 'table_inventory_missing_or_duplicate')
    require(all(t.get('engine') == 'InnoDB' for t in tables), 'non_innodb_source')
    require(all(not any(c in str(t) for c in "`'") for t in names), 'unsupported_identifier')
    require({c.get('table') for c in columns} == names, 'column_inventory_incomplete')
    primary = {x.get('table') for x in indexes if x.get('index') == 'PRIMARY'}
    require(primary == names, 'source_primary_key_missing')
    variables = {v.get('name'): v.get('value') for v in metadata.get('variables', [])}
    for name, value in {'log_bin': 'ON', 'binlog_format': 'ROW', 'binlog_row_image': 'FULL',
                        'binlog_transaction_compression': 'OFF', 'binlog_row_value_options': ''}.items():
        require(variables.get(name) == value, 'source_prerequisite_' + name)
    require(str(variables.get('server_id', '0')).isdigit() and int(variables.get('server_id', '0')) > 0,
            'source_server_id_invalid')
    require(str(variables.get('binlog_expire_logs_seconds', '')).isdigit()
            and int(variables.get('binlog_expire_logs_seconds', '0')) >= 86400, 'source_binlog_retention_unproven')
    require('TLSv1.2' in str(variables.get('tls_version', '')).split(','), 'source_tls12_unavailable')
    require(re.match(r'^8\.0\.', str(variables.get('version', ''))) is not None, 'source_version_not_reviewed')
    require(variables.get('lower_case_table_names') == '0', 'source_case_semantics_not_reviewed')
    lobs = [c for c in columns if c.get('type') in LOB_TYPES]
    affected = {c.get('table') for c in lobs if not c.get('nullable')}
    generated = [c for c in columns if re.search(r'(?:VIRTUAL|STORED) GENERATED', c.get('extra', ''))]
    require(not any('INVISIBLE' in c.get('extra', '') for c in columns), 'invisible_columns_unsupported')
    pilot = plan.get('pilot', {})
    require(pilot.get('source_schema') == pilot.get('target_schema') == 'cc_dms_pilot', 'synthetic_schema_required')
    require(pilot.get('isolated_mysqld_required') is True
            and pilot.get('real_patient_data_forbidden') is True
            and pilot.get('existing_crm_or_dev_database_forbidden') is True, 'synthetic_isolation_required')
    require(pilot.get('publicly_accessible') is False and pilot.get('automatic_start') is False,
            'private_manual_pilot_required')
    require(pilot.get('storage_encryption_required') is True, 'replication_storage_encryption_required')
    endpoints = plan.get('endpoints', {})
    require(set(endpoints) == {'source', 'target'}, 'endpoint_pair_required')
    for kind, endpoint in endpoints.items():
        require(endpoint.get('EngineName') == 'mysql' and endpoint.get('SslMode') == 'verify-full',
                'endpoint_strict_tls_required')
        require(re.fullmatch(r'arn:aws:dms:eu-west-3:[0-9]{12}:cert:[A-Za-z0-9_-]+',
                             str(endpoint.get('CertificateArn', ''))) is not None, kind + '_ca_reference_unresolved')
        require(re.fullmatch(r'arn:aws:secretsmanager:eu-west-3:[0-9]{12}:secret:.+',
                             str(endpoint.get('SecretsManagerSecretId', ''))) is not None, kind + '_credentials_reference_unresolved')
        require(re.fullmatch(r'arn:aws:iam::[0-9]{12}:role/.+',
                             str(endpoint.get('SecretsManagerAccessRoleArn', ''))) is not None, kind + '_secret_role_unresolved')
    require(re.fullmatch(r'[a-zA-Z0-9.-]+\.eu-west-3\.rds\.amazonaws\.com',
                         str(endpoints.get('target', {}).get('ServerName', ''))) is not None,
            'target_verified_hostname_unresolved')
    require(endpoints.get('source', {}).get('Port') == 23306, 'pilot_source_port_must_be_isolated')
    require(endpoints.get('source', {}).get('ServerName') == '172.26.0.110', 'pilot_source_private_host_required')
    require(endpoints.get('target', {}).get('Port') == 3306, 'pilot_target_mysql_port_required')
    rules = plan.get('table_mappings', {}).get('rules', [])
    require(rules == [{'rule-type': 'selection', 'rule-id': '1', 'rule-name': 'synthetic-only',
                      'object-locator': {'schema-name': 'cc_dms_pilot', 'table-name': '%'},
                      'rule-action': 'include'}], 'synthetic_mapping_scope_required')
    settings = plan.get('task_settings', {})
    target = settings.get('TargetMetadata', {})
    for name, value in {'SupportLobs': True, 'FullLobMode': True, 'LobChunkSize': 64,
                        'LimitedSizeLobMode': False, 'InlineLobMaxSize': 0, 'BatchApplyEnabled': False}.items():
        require(target.get(name) == value, 'lob_or_apply_policy_' + name)
    full = settings.get('FullLoadSettings', {})
    require(full.get('TargetTablePrepMode') == 'DO_NOTHING', 'native_target_schema_required')
    require(full.get('StopTaskCachedChangesApplied') is True
            and full.get('StopTaskCachedChangesNotApplied') is False, 'cascade_phase_stop_required')
    validation = settings.get('ValidationSettings', {})
    require(validation.get('EnableValidation') is True and validation.get('SkipLobColumns') is False
            and validation.get('ValidationPartialLobSize') == 0, 'complete_lob_validation_required')
    behavior = settings.get('ErrorBehavior', {})
    for key in ('DataErrorPolicy', 'DataTruncationErrorPolicy', 'TableErrorPolicy',
                'ApplyErrorDeletePolicy', 'ApplyErrorInsertPolicy', 'ApplyErrorUpdatePolicy'):
        require(behavior.get(key) == 'STOP_TASK', 'error_policy_' + key)
    require(behavior.get('FullLoadIgnoreConflicts') is False
            and behavior.get('FailOnTransactionConsistencyBreached') is True, 'no_silent_conflicts_required')
    require(settings.get('Logging', {}).get('EnableLogging') is False, 'row_bearing_logs_not_approved')
    require(set(plan.get('required_pilot_checks', [])) == REQUIRED_CHECKS, 'pilot_coverage_incomplete')
    outstanding = sorted(REQUIRED_CHECKS)
    if receipt:
        try:
            timestamp = receipt['observed_at_utc']
            if not isinstance(timestamp, str):
                raise ValueError('timestamp required')
            when = dt.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            age = (now - when).total_seconds()
            require(when.tzinfo is not None and -300 <= age <= 86400, 'pilot_receipt_stale_or_future')
        except (ValueError, KeyError, TypeError):
            errors.append('pilot_receipt_timestamp_invalid')
        require(receipt.get('schema') == 'clinicaclick-dms-pilot-receipt/1', 'pilot_receipt_schema_invalid')
        require(receipt.get('metadata_sha256') == digest(metadata), 'pilot_metadata_binding_mismatch')
        require(receipt.get('plan_sha256') == digest(plan), 'pilot_plan_binding_mismatch')
        require(receipt.get('data_classification') == 'synthetic_only', 'pilot_receipt_data_scope_invalid')
        checks = receipt.get('checks', {})
        outstanding = [k for k in sorted(REQUIRED_CHECKS)
                       if not isinstance(checks.get(k), dict) or checks[k].get('status') != 'passed'
                       or re.fullmatch(r'[0-9a-f]{64}', str(checks[k].get('evidence_sha256', ''))) is None]
        duration = receipt.get('fenced_finalization_seconds')
        require(isinstance(duration, (int, float)) and not isinstance(duration, bool)
                and 0 <= duration <= 120, 'cutover_120s_not_demonstrated')
    return {'schema': 'clinicaclick-dms-assessment/1', 'metadata_sha256': digest(metadata),
            'plan_sha256': digest(plan), 'configuration_errors': sorted(set(errors)),
            'unproven_pilot_checks': outstanding,
            'eligible_for_operator_review': not errors and not outstanding,
            # Receipts are operator-supplied evidence references, not independently authenticated AWS results.
            'receipt_authenticity_independently_verified': False,
            'deployment_authorized': False, 'patient_copy_authorized': False, 'cutover_authorized': False,
            'inventory': {'tables': len(tables), 'primary_key_tables': len(primary),
                          'dms_lob_columns': len(lobs), 'notnull_dms_lob_columns': sum(not c.get('nullable') for c in lobs),
                          'notnull_lob_tables': len(affected),
                          'notnull_lob_table_data_bytes': sum(t.get('data_bytes', 0) or 0 for t in tables if t.get('table') in affected),
                          'notnull_lob_table_index_bytes': sum(t.get('index_bytes', 0) or 0 for t in tables if t.get('table') in affected),
                          'generated_columns': len(generated), 'triggers': len(metadata.get('triggers', [])),
                          'fk_columns': len(metadata.get('foreign_keys', [])),
                          'fk_action_counts': dict(Counter(f.get('delete_rule', '?') + '/' + f.get('update_rule', '?')
                                                           for f in metadata.get('foreign_keys', [])))}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', required=True, type=Path)
    parser.add_argument('--plan', type=Path, default=Path(__file__).with_name('dms-pilot.plan.json'))
    parser.add_argument('--pilot-receipt', type=Path)
    args = parser.parse_args()
    try:
        result = assess(json.loads(args.metadata.read_text()), json.loads(args.plan.read_text()),
                        json.loads(args.pilot_receipt.read_text()) if args.pilot_receipt else None)
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'error': 'assessment_input_invalid', 'cutover_authorized': False}))
        return 2
    print(json.dumps(result, indent=2))
    return 0 if result['eligible_for_operator_review'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
