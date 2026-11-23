#!/usr/bin/env python3
"""Configuration bounds only: no network and no real configuration or key paths."""
import contextlib
import copy
import importlib.util
import json
import pathlib
import socket
import ssl
import stat
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('fixture_publisher', 'server-certificate-publisher.py')
S = load('fixture_signer', 'server-certificates.py')
CURRENT = [('authorized',8443),('onboarding',8444),('inbox',8445),('audit-writer',8446),
           ('audit-reader',8447),('ai-staging',8448),('bedrock-staging',8449),('publisher',8450),
           ('email-staging',8451),('email-dev',8452),('meta-marketing-dev',8453),
           ('meta-marketing-staging',8454),('public-media-dev',8455),
           ('google-business-profile-staging',8456)]
FUTURE = [('google-search-console-staging',8457),('google-analytics-staging',8458),
          ('google-ads-staging',8459),('google-ads-goal-policy-staging',8460)]
FIRST = [('google-first-owner-staging',8461)]
# Wholly fictional pins; these are not enrollment descriptors or live certificates.
CA_SHA, KEY_SHA, ID_SHA, CALLER_SHA = [c * 64 for c in 'abcd']


class SyntheticPath:
    def __init__(self, name, data=b'FICTIONAL_PUBLIC_FIXTURE'):
        self.name, self.data = name, data
    def read_bytes(self):
        return self.data
    def stat(self):
        return types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)
    @property
    def suffix(self):
        return pathlib.PurePosixPath(self.name).suffix
    @property
    def parents(self):
        return [SyntheticPath('/FICTIONAL_PARENT')]
    def __str__(self):
        return self.name


class ConfigurationTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='cc-google-transport-config-qa-')
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        for name in ('create_connection', 'socket'):
            guard = patch.object(socket, name, side_effect=AssertionError('NETWORK_FORBIDDEN'))
            guard.start()
            self.addCleanup(guard.stop)

    def targets(self, tuples):
        return [{'id':i, 'hostname':'13.39.100.55', 'port':port,
                 'certificateFile':'/etc/clinicaclick-FICTIONAL/'+i+'.crt',
                 'publicKeySha256':KEY_SHA, 'identitySha256':ID_SHA,
                 **({'peerAddress':'10.74.0.8'} if (i,port)==FIRST[0] else {})} for i,port in tuples]

    def configurations(self, tuples):
        targets = self.targets(tuples)
        publisher = next(t for t in targets if t['id']=='publisher')
        pub = {'version':1, 'listenAddress':'0.0.0.0', 'port':8450,
               'certificateFile':publisher['certificateFile'],
               'privateKeyFile':'/etc/clinicaclick-FICTIONAL/publisher.key',
               'issuerFile':'/etc/clinicaclick-FICTIONAL/ca.crt', 'issuerSha256':CA_SHA,
               'maintenancePublicKeySha256':CALLER_SHA,
               'stateDirectory':str(self.root/'publisher-state'), 'targets':targets}
        signer = {'version':1,
                  'authority':{'certificateFile':'/etc/clinicaclick-FICTIONAL/ca.crt',
                               'privateKeyFile':'/etc/clinicaclick-FICTIONAL/ca.key',
                               'certificateSha256':CA_SHA},
                  'maintenance':{'certificateFile':'/etc/clinicaclick-FICTIONAL/maintenance.crt',
                                 'privateKeyFile':'/etc/clinicaclick-FICTIONAL/maintenance.key',
                                 'publicKeySha256':CALLER_SHA, 'identitySha256':ID_SHA},
                  'stateDirectory':str(self.root/'signer-state'),
                  'statusFile':'/var/lib/clinicaclick-transport-health/servers.json',
                  'statusGroupId':1000,
                  'targets':[{k:v for k,v in t.items() if k not in ('certificateFile','peerAddress')} for t in targets]}
        return pub, signer

    def invoke(self, module, config):
        raw = json.dumps(config).encode()
        def private(name, **_):
            return SyntheticPath(str(name), raw if str(name)=='/FICTIONAL/config.json' else b'FICTIONAL')
        transport = module.transport if module is P else module.R
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(transport, 'private_path', side_effect=private))
            stack.enter_context(patch.object(transport, 'certificate_hash', return_value=CA_SHA))
            stack.enter_context(patch.object(transport, 'public_key_hash', return_value=KEY_SHA))
            stack.enter_context(patch.object(transport, 'command', return_value=b'FICTIONAL'))
            stack.enter_context(patch.object(P if module is P else S.publisher, 'identity', return_value=ID_SHA))
            if module is S:
                stack.enter_context(patch.object(S, 'validate_authority', return_value=(SyntheticPath('/FICTIONAL/ca'),SyntheticPath('/FICTIONAL/key'))))
            return module.configuration('/FICTIONAL/config.json')

    def both(self, configs):
        return [self.invoke(module,config) for module,config in zip((P,S),configs)]

    def test_current_fourteen_still_accepted(self):
        result = self.both(self.configurations(CURRENT))
        self.assertEqual([len(c['targets']) for c in result],[14,14])

    def test_future_eighteen_accepted_and_all_current_targets_preserved(self):
        original = self.configurations(CURRENT)
        future = self.both(self.configurations(CURRENT+FUTURE))
        for old, new in zip(original, future):
            self.assertEqual(new['targets'][:14],old['targets'])
            self.assertEqual(len(new['targets']),18)
            self.assertEqual([(t['id'],t['port']) for t in new['targets'][14:]],FUTURE)

    def test_nineteen_and_twenty_rejected_by_count_independently_of_port_guard(self):
        for count in (19,20):
            configs = self.configurations(CURRENT+FUTURE+[('extra-'+str(i),9000+i) for i in range(count-18)])
            # Isolate the numerical guard; the product whitelist remains strict.
            with patch.object(P, 'target_port_valid',return_value=True), patch.object(S.publisher,'target_port_valid',return_value=True):
                for module,config in zip((P,S),configs):
                    with self.assertRaisesRegex(module.Error,'configuration_invalid'):
                        self.invoke(module,config)

    def test_nineteenth_target_only_with_exact_first_owner_preserves_previous_eighteen(self):
        original=self.configurations(CURRENT+FUTURE)
        configs=self.configurations(CURRENT+FUTURE+FIRST)
        for old,new in zip(original,self.both(configs)):
            self.assertEqual(new['targets'][:18],old['targets'])
            self.assertEqual(len(new['targets']),19)
            self.assertEqual((new['targets'][-1]['id'],new['targets'][-1]['port']),FIRST[0])
        self.assertEqual(configs[0]['targets'][-1]['peerAddress'],'10.74.0.8')
        self.assertNotIn('peerAddress',configs[1]['targets'][-1])

    def test_twenty_targets_still_rejected_even_with_first_owner(self):
        configs=self.configurations(CURRENT+FUTURE+FIRST+[('extra',9001)])
        with patch.object(P,'target_port_valid',return_value=True),patch.object(S.publisher,'target_port_valid',return_value=True):
            for module,config in zip((P,S),configs):
                with self.assertRaisesRegex(module.Error,'configuration_invalid'):
                    self.invoke(module,config)

    def test_new_owner_identity_port_and_types_are_exact(self):
        for identity,port in [('foreign',8461),('google-first-owner-dev',8461),('google-first-owner-staging',8460),
                              ('google-first-owner-staging',8443),('google-first-owner-staging','8461'),
                              ('google-first-owner-staging',8461.0),('google-first-owner-staging',True)]:
            for module,config in zip((P,S),self.configurations(CURRENT+[(identity,port)])):
                with self.subTest(identity=identity,port=port,module=module.__name__),self.assertRaisesRegex(module.Error,'configuration_invalid'):
                    self.invoke(module,config)

    def test_private_peer_required_and_exact_only_for_new_publisher_target(self):
        for peer in [None,'127.0.0.1','0.0.0.0','::1','10.74.0.9','13.39.100.55','10.74.0.8:8461','http://10.74.0.8',8461]:
            pub,_=self.configurations(CURRENT+FIRST)
            if peer is None:pub['targets'][-1].pop('peerAddress')
            else:pub['targets'][-1]['peerAddress']=peer
            with self.subTest(peer=peer),self.assertRaisesRegex(P.Error,'configuration_invalid'):
                self.invoke(P,pub)
        pub,signer=self.configurations(CURRENT+FIRST)
        pub['targets'][0]['peerAddress']='10.74.0.8'
        with self.assertRaisesRegex(P.Error,'configuration_invalid'):self.invoke(P,pub)
        signer['targets'][-1]['peerAddress']='10.74.0.8'
        with self.assertRaisesRegex(S.Error,'configuration_invalid'):self.invoke(S,signer)

    def test_private_peer_never_changes_tls_hostname_ca_or_client_identity(self):
        target=self.targets(FIRST)[0]
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        sock=MagicMock();peer=MagicMock();peer.__enter__.return_value.getpeercert.return_value=b'FICTITIOUS_DER'
        with patch.object(P.ssl,'create_default_context',return_value=context) as factory, \
             patch.object(P.socket,'create_connection',return_value=sock) as connect, \
             patch.object(context,'load_cert_chain') as client,patch.object(context,'wrap_socket',return_value=peer) as wrap:
            digest=P.peer_fingerprint(target,'/FICTIONAL/ca.crt',('/FICTIONAL/client.crt','/FICTIONAL/client.key'))
        connect.assert_called_once_with(('10.74.0.8',8461),timeout=3)
        factory.assert_called_once_with(cafile='/FICTIONAL/ca.crt')
        wrap.assert_called_once_with(sock.__enter__.return_value,server_hostname='13.39.100.55')
        client.assert_called_once_with('/FICTIONAL/client.crt','/FICTIONAL/client.key')
        self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED);self.assertTrue(context.check_hostname)
        self.assertEqual(context.minimum_version,ssl.TLSVersion.TLSv1_2)
        self.assertEqual(digest,P.hashlib.sha256(b'FICTITIOUS_DER').hexdigest())
        self.assertEqual(P.peer_address(self.targets(CURRENT)[0]),'127.0.0.1')

    def test_new_registration_keeps_hostname_certificate_suffix_and_pins_exact(self):
        for field,value in [('hostname','10.74.0.8'),('certificateFile','/etc/clinicaclick-FICTIONAL/owner.pem'),
                            ('publicKeySha256','bad'),('identitySha256','bad')]:
            pub,_=self.configurations(CURRENT+FIRST);pub['targets'][-1][field]=value
            with self.subTest(field=field),self.assertRaises(P.Error):self.invoke(P,pub)

    def test_wrong_identity_port_and_types_rejected(self):
        for identity,port in [('foreign',8457),('google-search-console-staging',8458),
                              ('google-analytics-staging','8458'),('google-ads-staging',8459.0),
                              ('google-ads-goal-policy-staging',True),
                              ('google-ads-goal-policy-staging',None)]:
            tuples=CURRENT+[(identity,port)]
            for module,config in zip((P,S),self.configurations(tuples)):
                with self.assertRaisesRegex(module.Error,'configuration_invalid'):
                    self.invoke(module,config)

    def test_duplicate_identity_port_and_publisher_omission_still_rejected(self):
        for field,value in [('id','google-business-profile-staging'),('port',8456)]:
            configs=self.configurations(CURRENT+FUTURE)
            for config in configs:
                config['targets'][-1][field]=value
            for module,config in zip((P,S),configs):
                with self.assertRaisesRegex(module.Error,'configuration_invalid'):
                    self.invoke(module,config)
        pub,_=self.configurations(CURRENT+FUTURE)
        pub['targets']=[t for t in pub['targets'] if t['id']!='publisher']
        with self.assertRaisesRegex(P.Error,'publisher_renewal_target_missing'):
            self.invoke(P,pub)


if __name__=='__main__':
    unittest.main()
