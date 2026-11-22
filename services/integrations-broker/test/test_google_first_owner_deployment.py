import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('check_first', ROOT / 'deploy/check-google-first-owner.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def fixture(environment='staging'):
    directory = '/etc/clinicaclick-google-first-owner-' + environment
    return dict(environment=environment, enabled=True, cohort='google-first-oauth-v1', purpose='google-first-identity-only-v1',
                stateFile='/var/lib/clinicaclick-google-first-owner-' + environment + '/owner.sqlite',
                listenAddress='127.0.0.1', port=18461, tlsCertFile=directory+'/server-cert.pem', tlsKeyFile=directory+'/server-key.pem',
                tlsRenewal=dict(issuerCaFile=directory+'/issuer-ca.pem'), searchConsoleCursorKeyFile=directory+'/cursor.key',
                scopes=[dict(services=['search_console'])], slots=[dict(service='search_console')], publicationResources=[dict(service='search_console')],
                policy=dict(audience='clinicaclick:google-first-oauth:'+environment+':v1', version='google-first-oauth:'+environment+':v1',
                            connections=[], grants=[], principals=[dict(id='crm:'+environment+':google-first-oauth')]),
                searchConsoleReaderPrincipal=dict(id='crm:'+environment+':google-first-sc-reader'))


class Deployment(unittest.TestCase):
    def test_valid_both_instances(self):
        for environment in ('dev', 'staging'):
            check.validate(fixture(environment), environment)

    def test_environment_state_listener_and_cohort_are_closed(self):
        for changes in [dict(environment='dev'), dict(stateFile='/var/lib/clinicaclick-google-business-profile-staging/state.sqlite'),
                        dict(listenAddress='0.0.0.0'), dict(listenAddress='8.8.8.8'), dict(port=443), dict(port=True), dict(enabled=False),
                        dict(cohort='google-search-console-read-v1'), dict(tlsKeyFile='/etc/old-owner/server-key.pem'),
                        dict(scopes=[dict(services=['analytics'])]), dict(searchConsoleReaderPrincipal=dict(id='old-reader'))]:
            value = fixture(); value.update(changes)
            with self.subTest(changes=changes), self.assertRaises(Exception):
                check.validate(value, 'staging')

    def test_service_exact_isolation_and_runtime(self):
        text = (ROOT / 'deploy/clinicaclick-google-first-owner@.service').read_text()
        for line in ['User=cc-google-first-%i', 'Group=cc-google-first-%i', 'StateDirectoryMode=0700',
                     'WorkingDirectory=/opt/clinicaclick-google-first-owner-%i/current',
                     'ReadWritePaths=/var/lib/clinicaclick-google-first-owner-%i', 'ProtectSystem=strict', 'ProtectHome=true', 'UMask=0077',
                     'ExecStartPre=/usr/bin/python3 deploy/check-google-first-owner.py %i',
                     'ExecStart=/opt/clinicaclick-audit/node-v24.21.0-recovery1/bin/node --max-old-space-size=128 src/google-first-admission-main.js /etc/clinicaclick-google-first-owner-%i/config.json']:
            self.assertIn(line, text.splitlines())
        for forbidden in ['WantedBy=', 'EnvironmentFile=', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DynamicUser=true', 'PrivateUsers=true',
                          'src/main.js', 'src/google-main.js', 'cc-google-gbp-', 'cc-meta-']:
            self.assertNotIn(forbidden, text)
        self.assertIn('AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_V1_DISABLED=true AWS_EC2_METADATA_SERVICE_ENDPOINT=http://169.254.169.254', text)


if __name__ == '__main__':
    unittest.main()
