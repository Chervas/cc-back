import copy
import datetime as dt
import json
import unittest
from pathlib import Path

from assess_dms_metadata import REQUIRED_CHECKS, assess, digest


NOW = dt.datetime(2026, 10, 18, 15, tzinfo=dt.timezone.utc)


def fixture():
    """Fictional metadata/evidence fixtures, not AWS verification receipts."""
    metadata = {
        'schema': 'dms-source-metadata/1',
        'tables': [{'table': 'pilot', 'engine': 'InnoDB'}],
        'columns': [{'table': 'pilot', 'column': 'body', 'type': 'json', 'nullable': False, 'extra': ''},
                    {'table': 'pilot', 'column': 'computed', 'type': 'varchar', 'nullable': True, 'extra': 'STORED GENERATED'},
                    {'table': 'pilot', 'column': 'created_at', 'type': 'datetime', 'nullable': False, 'extra': 'DEFAULT_GENERATED'}],
        'indexes': [{'table': 'pilot', 'index': 'PRIMARY'}],
        'foreign_keys': [{'delete_rule': 'CASCADE', 'update_rule': 'SET NULL'}],
        'triggers': [{'name': 'pilot_guard'}],
        'variables': [{'name': k, 'value': v} for k, v in {
            'log_bin': 'ON', 'binlog_format': 'ROW', 'binlog_row_image': 'FULL',
            'binlog_transaction_compression': 'OFF', 'binlog_row_value_options': '',
            'server_id': '1', 'binlog_expire_logs_seconds': '1296000',
            'tls_version': 'TLSv1.2,TLSv1.3', 'version': '8.0.42', 'lower_case_table_names': '0'}.items()],
    }
    plan = json.loads(Path(__file__).with_name('dms-pilot.plan.json').read_text())
    for endpoint in plan['endpoints'].values():
        endpoint.update(CertificateArn='arn:aws:dms:eu-west-3:000000000000:cert:FIXTURE',
                        SecretsManagerSecretId='arn:aws:secretsmanager:eu-west-3:000000000000:secret:fixture',
                        SecretsManagerAccessRoleArn='arn:aws:iam::000000000000:role/fixture')
    plan['endpoints']['target']['ServerName'] = 'fixture.fixture.eu-west-3.rds.amazonaws.com'
    receipt = {'schema': 'clinicaclick-dms-pilot-receipt/1', 'observed_at_utc': NOW.isoformat(),
               'metadata_sha256': digest(metadata), 'plan_sha256': digest(plan),
               'data_classification': 'synthetic_only', 'fenced_finalization_seconds': 100,
               'checks': {name: {'status': 'passed', 'evidence_sha256': 'a' * 64} for name in REQUIRED_CHECKS}}
    return metadata, plan, receipt


class AssessmentTests(unittest.TestCase):
    def test_even_complete_references_never_authorize_actions(self):
        result = assess(*fixture(), now=NOW)
        self.assertTrue(result['eligible_for_operator_review'])
        for key in ('deployment_authorized', 'patient_copy_authorized', 'cutover_authorized',
                    'receipt_authenticity_independently_verified'):
            self.assertFalse(result[key])

    def test_real_draft_requires_resolved_endpoint_references(self):
        metadata, _, receipt = fixture()
        plan = json.loads(Path(__file__).with_name('dms-pilot.plan.json').read_text())
        result = assess(metadata, plan, receipt, now=NOW)
        self.assertFalse(result['eligible_for_operator_review'])
        self.assertIn('source_ca_reference_unresolved', result['configuration_errors'])
        self.assertIn('target_verified_hostname_unresolved', result['configuration_errors'])

    def test_every_pilot_feature_needs_hashed_evidence(self):
        for name in REQUIRED_CHECKS:
            with self.subTest(name=name):
                metadata, plan, receipt = fixture()
                del receipt['checks'][name]
                result = assess(metadata, plan, receipt, now=NOW)
                self.assertIn(name, result['unproven_pilot_checks'])
                self.assertFalse(result['eligible_for_operator_review'])

    def test_boolean_or_plain_status_is_not_evidence(self):
        metadata, plan, receipt = fixture()
        for value in (True, 'passed', {'status': 'passed'}, {'status': 'passed', 'evidence_sha256': 'invalid'}):
            receipt['checks']['tls_wrong_ca_rejected'] = value
            self.assertFalse(assess(metadata, plan, receipt, now=NOW)['eligible_for_operator_review'])

    def test_binding_stale_future_and_slow_finalization_fail_closed(self):
        for key, value in [('metadata_sha256', 'b' * 64), ('plan_sha256', 'b' * 64),
                           ('observed_at_utc', (NOW - dt.timedelta(days=2)).isoformat()),
                           ('observed_at_utc', (NOW + dt.timedelta(hours=1)).isoformat()),
                           ('observed_at_utc', None),
                           ('fenced_finalization_seconds', 121), ('fenced_finalization_seconds', True),
                           ('data_classification', 'clinical')]:
            with self.subTest(key=key, value=value):
                metadata, plan, receipt = fixture(); receipt[key] = value
                self.assertFalse(assess(metadata, plan, receipt, now=NOW)['eligible_for_operator_review'])

    def test_native_generated_is_not_confused_with_default_generated(self):
        result = assess(*fixture(), now=NOW)
        self.assertEqual(result['inventory']['generated_columns'], 1)
        self.assertEqual(result['inventory']['notnull_dms_lob_columns'], 1)

    def test_source_prerequisites_are_required_individually(self):
        for name in ('log_bin', 'binlog_format', 'binlog_row_image', 'binlog_transaction_compression',
                     'binlog_row_value_options', 'server_id', 'binlog_expire_logs_seconds',
                     'tls_version', 'version', 'lower_case_table_names'):
            with self.subTest(name=name):
                metadata, plan, receipt = fixture()
                metadata['variables'] = [v for v in metadata['variables'] if v['name'] != name]
                self.assertFalse(assess(metadata, plan, receipt, now=NOW)['eligible_for_operator_review'])

    def test_without_pk_or_with_invisible_column_not_reviewable(self):
        metadata, plan, receipt = fixture(); metadata['indexes'] = []
        self.assertIn('source_primary_key_missing', assess(metadata, plan, receipt, now=NOW)['configuration_errors'])
        metadata, plan, receipt = fixture(); metadata['columns'][0]['extra'] = 'INVISIBLE'
        self.assertIn('invisible_columns_unsupported', assess(metadata, plan, receipt, now=NOW)['configuration_errors'])

    def test_plan_security_mutations_rejected(self):
        mutations = [
            lambda p: p['endpoints']['source'].update(SslMode='verify-ca'),
            lambda p: p['endpoints']['target'].update(SslMode='none'),
            lambda p: p['endpoints']['source'].update(Password='fixture-only'),
            lambda p: p['pilot'].update(source_schema='clinicaclick'),
            lambda p: p['pilot'].update(real_patient_data_forbidden=False),
            lambda p: p['endpoints']['source'].update(Port=13306),
            lambda p: p['endpoints']['source'].update(ServerName='other.example'),
            lambda p: p['endpoints']['target'].update(Port=3307),
            lambda p: p['clinical_copy'].update(start_authorized=True),
            lambda p: p['table_mappings']['rules'][0]['object-locator'].update({'schema-name': '%'}),
            lambda p: p['task_settings']['TargetMetadata'].update(LimitedSizeLobMode=True),
            lambda p: p['task_settings']['TargetMetadata'].update(FullLobMode=False),
            lambda p: p['task_settings']['FullLoadSettings'].update(StopTaskCachedChangesApplied=False),
            lambda p: p['task_settings']['ValidationSettings'].update(SkipLobColumns=True),
            lambda p: p['task_settings']['ValidationSettings'].update(ValidationPartialLobSize=32),
            lambda p: p['task_settings']['ErrorBehavior'].update(DataTruncationErrorPolicy='LOG_ERROR'),
            lambda p: p['task_settings']['Logging'].update(EnableLogging=True),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                metadata, plan, receipt = fixture(); mutate(plan)
                receipt['plan_sha256'] = digest(plan)
                self.assertFalse(assess(metadata, plan, receipt, now=NOW)['eligible_for_operator_review'])


if __name__ == '__main__':
    unittest.main()
