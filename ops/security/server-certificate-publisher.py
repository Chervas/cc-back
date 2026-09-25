#!/usr/bin/env python3
"""Install CA-signed server leaves with unchanged identities; no key export.

Private config and executable belong to root. The maintenance caller has its
own mTLS key, separate from gateway and CRM. This service cannot issue leaves.
"""
import datetime as dt
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import re
import socket
import ssl
import stat
import tempfile
import time

spec = importlib.util.spec_from_file_location('transport', pathlib.Path(__file__).with_name('transport-certificates.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
Error = transport.CertificateError
UTC = dt.timezone.utc


def target_port_valid(target):
    port=target.get('port');identity=target.get('id')
    dedicated_ports={'email-staging':8451,'email-dev':8452,
                     'meta-marketing-dev':8453,'meta-marketing-staging':8454,
                     'public-media-dev':8455,
                     'google-business-profile-staging':8456}
    if not isinstance(port,int):return False
    if identity in dedicated_ports:return port==dedicated_ports[identity]
    return 8443<=port<=8450


def identity(path):
    fields = transport.command(['x509', '-in', str(path), '-noout', '-subject', '-nameopt', 'RFC2253',
        '-ext', 'subjectAltName,extendedKeyUsage,keyUsage,basicConstraints'])
    return hashlib.sha256(fields).hexdigest()


def validate_leaf(path, target, ca, now=None):
    now = now or dt.datetime.now(UTC)
    data = pathlib.Path(path).read_bytes()
    if not re.fullmatch(rb'\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*', data):
        raise Error('certificate_format_invalid')
    transport.command(['verify', '-purpose', 'sslserver', '-verify_ip', target['hostname'], '-CAfile', str(ca), str(path)])
    if transport.public_key_hash(path) != target['publicKeySha256'] or identity(path) != target['identitySha256']:
        raise Error('certificate_identity_changed')
    expires = transport.expires(path)
    if not now + dt.timedelta(days=1) < expires <= now + dt.timedelta(days=31):
        raise Error('certificate_validity_invalid')
    if expires > transport.expires(ca):
        raise Error('certificate_issuer_expiring')
    return expires


def peer_fingerprint(target, ca, client=None):
    context = ssl.create_default_context(cafile=str(ca))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    if client:
        context.load_cert_chain(*client)
    with socket.create_connection(('127.0.0.1', target['port']), timeout=3) as sock:
        with context.wrap_socket(sock, server_hostname=target['hostname']) as connection:
            return hashlib.sha256(connection.getpeercert(binary_form=True)).hexdigest()


def publish(target, candidate_bytes, ca, state_dir, probe=peer_fingerprint, on_install=None,
            wait_seconds=70, sleep=time.sleep):
    installed = transport.private_path(target['certificateFile'])
    before = installed.read_bytes()
    before_hash = transport.certificate_hash(installed)
    # Current leaf is also bound to the immutable root policy. A service account
    # cannot redirect renewal by replacing its current certificate or a symlink.
    if transport.public_key_hash(installed) != target['publicKeySha256'] or identity(installed) != target['identitySha256']:
        raise Error('installed_identity_changed')
    with tempfile.TemporaryDirectory(prefix='server-leaf-', dir=str(state_dir)) as temp:
        candidate = pathlib.Path(temp)/'candidate.crt'
        candidate.write_bytes(candidate_bytes); candidate.chmod(0o600)
        expiration = validate_leaf(candidate, target, ca)
        digest = transport.certificate_hash(candidate)
        if digest == before_hash:
            if probe(target, ca) != digest:
                raise Error('installed_certificate_not_served')
            return {'id': target['id'], 'status': 'unchanged', 'fingerprint': digest, 'expiresAt': expiration.isoformat()}
        if expiration <= transport.expires(installed):
            raise Error('certificate_rollback_rejected')
        info = installed.stat()
        if installed.read_bytes() != before:
            raise Error('concurrent_certificate_change')
        backup = pathlib.Path(state_dir)/(target['id']+'-'+before_hash+'.crt')
        if not backup.exists():
            transport.atomic_write(backup, before, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        transport.atomic_write(installed, candidate_bytes, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        try:
            if on_install:
                on_install(target)
            deadline = time.monotonic()+wait_seconds
            while True:
                try:
                    if probe(target, ca) == digest:
                        return {'id': target['id'], 'status': 'renewed', 'fingerprint': digest, 'expiresAt': expiration.isoformat()}
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    raise Error('certificate_not_reloaded')
                sleep(1)
        except Exception:
            transport.atomic_write(installed, before, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
            if on_install:
                on_install(target)
            raise Error('server_renewal_rolled_back')


def configuration(filename):
    config = json.loads(transport.private_path(filename, root_only=True).read_bytes())
    keys = {'version','listenAddress','port','certificateFile','privateKeyFile','issuerFile','issuerSha256',
            'maintenancePublicKeySha256','stateDirectory','targets'}
    if set(config) != keys or config['version'] != 1 or config['listenAddress'] != '0.0.0.0' or config['port'] != 8450:
        raise Error('configuration_invalid')
    ca = transport.private_path(config['issuerFile'], root_only=True)
    if transport.certificate_hash(ca) != config['issuerSha256'] or not re.fullmatch('[a-f0-9]{64}',config['maintenancePublicKeySha256']):
        raise Error('issuer_or_caller_invalid')
    state = pathlib.Path(config['stateDirectory'])
    if not state.is_absolute() or state.resolve() != state:
        raise Error('unsafe_state_directory')
    state.mkdir(mode=0o700,parents=True,exist_ok=True)
    if state.stat().st_uid != 0 or stat.S_IMODE(state.stat().st_mode) != 0o700:
        raise Error('unsafe_state_directory')
    ids = set(); files = set(); ports = set()
    if not 1 <= len(config['targets']) <= 14:
        raise Error('configuration_invalid')
    for target in config['targets']:
        if set(target) != {'id','certificateFile','hostname','port','publicKeySha256','identitySha256'} \
          or not re.fullmatch('[a-z][a-z0-9-]{1,39}',target['id']) or target['hostname'] != '13.39.100.55' \
          or not target_port_valid(target) \
          or any(not re.fullmatch('[a-f0-9]{64}',target[k]) for k in ['publicKeySha256','identitySha256']):
            raise Error('configuration_invalid')
        file = transport.private_path(target['certificateFile'])
        if not str(file).startswith('/etc/clinicaclick-') or file.suffix != '.crt' \
          or target['id'] in ids or str(file) in files or target['port'] in ports:
            raise Error('configuration_invalid')
        for parent in file.parents:
            info=parent.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise Error('unsafe_certificate_directory')
        if identity(file) != target['identitySha256'] or transport.public_key_hash(file) != target['publicKeySha256']:
            raise Error('installed_identity_changed')
        ids.add(target['id']);files.add(str(file));ports.add(target['port'])
    if not any(t['certificateFile']==config['certificateFile'] and t['port']==config['port'] for t in config['targets']):
        raise Error('publisher_renewal_target_missing')
    for field in ['certificateFile','privateKeyFile']:
        transport.private_path(config[field],root_only=True)
    if transport.public_key_hash(config['certificateFile']) != transport.public_key_hash(config['privateKeyFile'],False):
        raise Error('publisher_key_mismatch')
    transport.command(['verify','-purpose','sslclient','-CAfile',str(ca),config['certificateFile']])
    transport.command(['verify','-purpose','sslserver','-CAfile',str(ca),config['certificateFile']])
    return config


class Publisher(http.server.HTTPServer):
    allow_reuse_address = True
    def __init__(self, config):
        self.config = config
        self.context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH,cafile=config['issuerFile'])
        self.context.minimum_version = ssl.TLSVersion.TLSv1_2
        self.context.verify_mode = ssl.CERT_REQUIRED
        self.context.load_cert_chain(config['certificateFile'],config['privateKeyFile'])
        super().__init__((config['listenAddress'],config['port']),Handler)

    def get_request(self):
        sock, address = self.socket.accept();sock.settimeout(8)
        try:
            return self.context.wrap_socket(sock,server_side=True),address
        except Exception:
            sock.close();raise

    def reload_own(self, target):
        if target['certificateFile']==self.config['certificateFile']:
            self.context.load_cert_chain(self.config['certificateFile'],self.config['privateKeyFile'])

    def probe(self, target, ca):
        # The single-thread publisher cannot handshake with itself while serving
        # this request. Caller verifies its new certificate in another connection.
        if target['certificateFile']==self.config['certificateFile']:
            return transport.certificate_hash(target['certificateFile'])
        return peer_fingerprint(target,ca,(self.config['certificateFile'],self.config['privateKeyFile']))

    def handle_error(self, request, client_address):
        print(json.dumps({'event':'server_certificate_publisher','status':'request_failed'}),flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):
        pass
    def reply(self,status,body):
        raw=json.dumps(body,separators=(',',':')).encode()
        self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)));self.send_header('Connection','close');self.end_headers()
        self.wfile.write(raw)
    def allowed(self):
        cert = self.connection.getpeercert(binary_form=True)
        pem=ssl.DER_cert_to_PEM_cert(cert).encode()
        public=transport.command(['x509','-pubkey','-noout'],pem)
        digest=hashlib.sha256(transport.command(['pkey','-pubin','-outform','DER'],public)).hexdigest()
        return digest==self.server.config['maintenancePublicKeySha256']
    def do_GET(self):
        try:
            if self.path=='/healthz' and self.allowed():
                self.reply(200,{'status':'ready'})
            else:
                self.reply(403,{'error':'scope_denied'})
        except Exception:
            self.reply(403,{'error':'scope_denied'})
    def do_POST(self):
        try:
            if self.path!='/v1/certificates/publish' or not self.allowed():
                self.reply(403,{'error':'scope_denied'});return
            length=self.headers.get('Content-Length','')
            if not re.fullmatch('[0-9]{1,6}',length) or not 1 <= int(length) <= 16384 \
              or len(self.headers.get_all('Content-Length',[]))!=1 \
              or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Encoding') \
              or self.headers.get('Content-Type')!='application/json':
                raise Error('invalid_request')
            value=json.loads(self.rfile.read(int(length)))
            if set(value)!={'id','certificate'} or not isinstance(value['certificate'],str):
                raise Error('invalid_request')
            config=self.server.config
            target=next((t for t in config['targets'] if t['id']==value['id']),None)
            if not target:
                self.reply(403,{'error':'scope_denied'});return
            result=publish(target,value['certificate'].encode(),config['issuerFile'],config['stateDirectory'],
                probe=self.server.probe,on_install=self.server.reload_own)
            print(json.dumps({'event':'server_certificate_publisher',**result}),flush=True)
            self.reply(200,result)
        except Exception as error:
            reason=str(error) if isinstance(error,Error) else 'certificate_publish_failed'
            print(json.dumps({'event':'server_certificate_publisher','status':'failed','reason':reason}),flush=True)
            self.reply(400,{'error':reason})


if __name__=='__main__':
    import sys
    try:
        if os.geteuid()!=0:
            raise Error('root_required')
        Publisher(configuration(sys.argv[1])).serve_forever()
    except Exception:
        print(json.dumps({'event':'server_certificate_publisher','status':'startup_failed'}),flush=True)
        raise SystemExit(1)
