#!/usr/bin/env python3
"""Synthetic CA and loopback mTLS; no cloud APIs or operational keys."""
import http.client
import importlib.util
import json
import pathlib
import ssl
import tempfile
import threading
import unittest

spec=importlib.util.spec_from_file_location('publisher',pathlib.Path(__file__).with_name('server-certificate-publisher.py'))
P=importlib.util.module_from_spec(spec);spec.loader.exec_module(P)
R=P.transport


class PublisherTest(unittest.TestCase):
    def test_dedicated_ports_are_bound_to_the_declared_service_identities(self):
        for identity,port in [('email-staging',8451),('email-dev',8452),('publisher',8450),('bedrock-staging',8449),
                              ('meta-marketing-dev',8453),('meta-marketing-staging',8454),('public-media-dev',8455)]:
            self.assertTrue(P.target_port_valid({'id':identity,'port':port}))
        for identity,port in [('foreign',8451),('foreign',8452),('email-dev',8451),('email-staging',8452),
                              ('email-dev',8449),('email-staging',8450),('email-dev',8453),('email-dev','8452'),
                              ('foreign',8453),('foreign',8454),('foreign',8455),('meta-marketing-dev',8454),
                              ('meta-marketing-staging',8453),('public-media-dev',8454),('public-media-dev',8453),
                              ('meta-marketing-dev',8455),('meta-marketing-dev',8449),('meta-marketing-staging',8450),
                              ('meta-marketing-dev','8453'),('public-media-dev','8455')]:
            self.assertFalse(P.target_port_valid({'id':identity,'port':port}))

    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='cc-server-cert-qa-');self.addCleanup(temp.cleanup)
        self.root=pathlib.Path(temp.name);self.ca=self.root/'ca.crt'
        (self.root/'ca.cnf').write_text('[req]\ndistinguished_name=dn\n[dn]\n')
        R.command(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
            '-config',str(self.root/'ca.cnf'),
            '-keyout',str(self.root/'ca.key'),'-out',str(self.ca),'-days','365','-subj','/CN=FICTITIOUS_CA',
            '-addext','basicConstraints=critical,CA:TRUE'])
        self.leaf('server',20,'serverAuth,clientAuth');self.leaf('maintenance',30,'clientAuth')
        self.leaf('foreign',30,'clientAuth')
        self.target={'id':'publisher','certificateFile':str(self.root/'server.crt'),'hostname':'127.0.0.1','port':8450,
            'publicKeySha256':R.public_key_hash(self.root/'server.crt'),'identitySha256':P.identity(self.root/'server.crt')}
        self.old=(self.root/'server.crt').read_bytes();self.key=(self.root/'server.key').read_bytes()
        # Issue from the public certificate: the remote private key is unnecessary.
        self.candidate=self.root/'renewed.crt'
        R.command(['x509','-in',str(self.root/'server.crt'),'-CA',str(self.ca),'-CAkey',str(self.root/'ca.key'),
            '-set_serial','900','-days','30','-out',str(self.candidate)])
        self.candidate.chmod(0o600)

    def leaf(self,name,days,purpose):
        R.command(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(self.root/(name+'.key')),
            '-out',str(self.root/(name+'.csr')),'-subj','/CN=FICTITIOUS_'+name])
        ext=self.root/(name+'.ext');ext.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+purpose+'\nsubjectAltName=IP:127.0.0.1\n')
        R.command(['x509','-req','-in',str(self.root/(name+'.csr')),'-CA',str(self.ca),'-CAkey',str(self.root/'ca.key'),
            '-set_serial',str(100+len(name)),'-days',str(days),'-extfile',str(ext),'-out',str(self.root/(name+'.crt'))])
        for suffix in ['.key','.crt']:(self.root/(name+suffix)).chmod(0o600)

    def test_installs_only_same_identity_preserves_key_and_backups(self):
        result=P.publish(self.target,self.candidate.read_bytes(),self.ca,self.root,
            probe=lambda *_:R.certificate_hash(self.root/'server.crt'))
        self.assertEqual(result['status'],'renewed')
        self.assertEqual((self.root/'server.key').read_bytes(),self.key)
        self.assertEqual(next(self.root.glob('publisher-*.crt')).read_bytes(),self.old)
        self.assertEqual((self.root/'server.crt').stat().st_mode & 0o777,0o600)

    def test_no_reload_rolls_back_and_does_not_report_success(self):
        digest=R.certificate_hash(self.root/'server.crt')
        with self.assertRaisesRegex(R.CertificateError,'server_renewal_rolled_back'):
            P.publish(self.target,self.candidate.read_bytes(),self.ca,self.root,probe=lambda *_:digest,wait_seconds=0)
        self.assertEqual((self.root/'server.crt').read_bytes(),self.old)

    def test_rejects_other_key_purpose_and_appended_private_material(self):
        for candidate in [(self.root/'foreign.crt').read_bytes(),self.candidate.read_bytes()+self.key]:
            with self.assertRaises(R.CertificateError):P.publish(self.target,candidate,self.ca,self.root)
            self.assertEqual((self.root/'server.crt').read_bytes(),self.old)
        wrong=dict(self.target,publicKeySha256='0'*64)
        with self.assertRaisesRegex(R.CertificateError,'installed_identity_changed'):
            P.publish(wrong,self.candidate.read_bytes(),self.ca,self.root)

    def test_rejects_rollback_to_old_valid_certificate(self):
        P.publish(self.target,self.candidate.read_bytes(),self.ca,self.root,probe=lambda *_:R.certificate_hash(self.root/'server.crt'))
        with self.assertRaisesRegex(R.CertificateError,'certificate_rollback_rejected'):
            P.publish(self.target,self.old,self.ca,self.root)
        self.assertEqual((self.root/'server.crt').read_bytes(),self.candidate.read_bytes())

    def test_http_mtls_pin_reload_and_replay_over_real_tls(self):
        config={'listenAddress':'127.0.0.1','port':0,'certificateFile':str(self.root/'server.crt'),
            'privateKeyFile':str(self.root/'server.key'),'issuerFile':str(self.ca),
            'maintenancePublicKeySha256':R.public_key_hash(self.root/'maintenance.crt'),'stateDirectory':str(self.root),'targets':[self.target]}
        server=P.Publisher(config);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        port=server.server_address[1]
        def post(name,payload):
            context=ssl.create_default_context(cafile=str(self.ca));context.load_cert_chain(str(self.root/(name+'.crt')),str(self.root/(name+'.key')))
            connection=http.client.HTTPSConnection('127.0.0.1',port,context=context,timeout=5)
            try:
                connection.request('POST','/v1/certificates/publish',json.dumps(payload),{'Content-Type':'application/json'})
                response=connection.getresponse();return response.status,json.loads(response.read())
            finally:connection.close()
        payload={'id':'publisher','certificate':self.candidate.read_text()}
        self.assertEqual(post('foreign',payload),(403,{'error':'scope_denied'}))
        self.assertEqual(post('maintenance',dict(payload,id='unregistered')),(403,{'error':'scope_denied'}))
        status,result=post('maintenance',payload);self.assertEqual(status,200);self.assertEqual(result['status'],'renewed')
        # A second TLS handshake verifies the newly served leaf, not only disk.
        context=ssl.create_default_context(cafile=str(self.ca));context.load_cert_chain(str(self.root/'maintenance.crt'),str(self.root/'maintenance.key'))
        connection=http.client.HTTPSConnection('127.0.0.1',port,context=context,timeout=5);connection.connect()
        actual=P.hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest();connection.close()
        self.assertEqual(actual,R.certificate_hash(self.candidate))
        self.assertEqual(post('maintenance',payload)[1]['status'],'unchanged')
        self.assertEqual((self.root/'server.key').read_bytes(),self.key)


if __name__=='__main__':unittest.main()
