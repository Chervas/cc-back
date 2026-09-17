#!/usr/bin/env python3
"""Server signer, real loopback mTLS and rollback; only fictitious keys."""
import http.client
import importlib.util
import json
import pathlib
import ssl
import threading
import unittest
from unittest.mock import patch


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,pathlib.Path(__file__).with_name(file))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


S=load('signer','server-certificates.py')
Fixtures=load('fixtures','test-server-certificate-publisher.py')
R=S.R


class SignerTest(unittest.TestCase):
    leaf=Fixtures.PublisherTest.leaf
    def setUp(self):
        Fixtures.PublisherTest.setUp(self)
        for name in ['ca.crt','ca.key']:(self.root/name).chmod(0o600)
        self.config={'authority':{'certificateFile':str(self.ca),'privateKeyFile':str(self.root/'ca.key'),
            'certificateSha256':R.certificate_hash(self.ca)},
            'maintenance':{'certificateFile':str(self.root/'maintenance.crt'),'privateKeyFile':str(self.root/'maintenance.key'),
                'publicKeySha256':R.public_key_hash(self.root/'maintenance.crt'),'identitySha256':S.publisher.identity(self.root/'maintenance.crt')},
            'stateDirectory':str(self.root)}

    def test_fresh_leaf_is_checked_without_signing_or_publishing(self):
        def forbidden(*args,**kwargs):raise AssertionError('must_not_publish_or_sign')
        with patch.object(S,'issue_leaf',forbidden):
            result=S.renew_server(self.config,self.target,send=forbidden,fetch=lambda *_:self.old)
        self.assertEqual(result['status'],'healthy')

    def test_signer_and_publisher_accept_same_new_leaf_over_real_tls(self):
        P=S.publisher
        server=P.Publisher({'listenAddress':'127.0.0.1','port':0,'certificateFile':str(self.root/'server.crt'),
            'privateKeyFile':str(self.root/'server.key'),'issuerFile':str(self.ca),
            'maintenancePublicKeySha256':self.config['maintenance']['publicKeySha256'],
            'stateDirectory':str(self.root),'targets':[self.target]})
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        port=server.server_address[1]
        real_connection=http.client.HTTPSConnection
        def loopback(host,requested_port,**kwargs):
            self.assertEqual((host,requested_port),('13.39.100.55',8450))
            return real_connection('127.0.0.1',port,**kwargs)
        def fetch(*_):
            ctx=ssl.create_default_context(cafile=str(self.ca))
            ctx.load_cert_chain(self.config['maintenance']['certificateFile'],self.config['maintenance']['privateKeyFile'])
            conn=real_connection('127.0.0.1',port,context=ctx,timeout=5)
            try:
                conn.connect();return ssl.DER_cert_to_PEM_cert(conn.sock.getpeercert(binary_form=True)).encode()
            finally:conn.close()
        def send(*args,**kwargs):return S.request(*args,**kwargs,connection_factory=loopback)
        self.assertEqual(S.renew_maintenance(self.config,send=send)['status'],'healthy')
        self.assertEqual(S.renew_maintenance(self.config,send=send,force=True)['status'],'renewed')
        result=S.renew_server(self.config,self.target,send=send,fetch=fetch,force=True)
        self.assertEqual(result['status'],'renewed')
        self.assertEqual(S.renew_server(self.config,self.target,send=send,fetch=fetch)['status'],'healthy')
        self.assertEqual((self.root/'server.key').read_bytes(),self.key)
        self.assertEqual(result['fingerprint'],R.certificate_hash(self.root/'server.crt'))

    def test_bad_receipt_or_old_served_leaf_cannot_report_success(self):
        for mode in ['bad_receipt','not_reloaded']:
            def send(config,method,body):
                if mode=='bad_receipt':return {'status':'renewed'}
                received=self.root/'received.crt';received.write_text(body['certificate']);received.chmod(0o600)
                return {'id':self.target['id'],'status':'renewed','fingerprint':R.certificate_hash(received),
                    'expiresAt':R.expires(received).isoformat()}
            with self.assertRaisesRegex(R.CertificateError,'publisher_receipt_invalid|renewed_server_not_observed'):
                S.renew_server(self.config,self.target,send=send,fetch=lambda *_:self.old,force=True)
        self.assertEqual((self.root/'server.crt').read_bytes(),self.old)

    def test_maintenance_rejection_preserves_certificate(self):
        cert=self.root/'maintenance.crt';before=cert.read_bytes();calls=[]
        def send(*args,**kwargs):
            calls.append(kwargs)
            if len(calls)==1:return {'status':'ready'}
            raise TimeoutError()
        with self.assertRaisesRegex(R.CertificateError,'maintenance_renewal_rolled_back'):
            S.renew_maintenance(self.config,send=send,force=True)
        self.assertEqual(cert.read_bytes(),before)
        self.assertEqual(len(calls),2)

    def test_changed_authority_cannot_sign(self):
        config=dict(self.config['authority'],certificateSha256='0'*64)
        with self.assertRaisesRegex(R.CertificateError,'authority_identity_changed'):
            S.issue_leaf(self.root/'server.crt',self.root/'must-not-exist.crt',config)
        self.assertFalse((self.root/'must-not-exist.crt').exists())


if __name__=='__main__':unittest.main()
