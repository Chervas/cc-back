#!/usr/bin/env python3
"""Root signer/maintenance client. Server private keys remain exclusively on AWS."""
import datetime as dt
import fcntl
import http.client
import importlib.util
import json
import os
import pathlib
import re
import socket
import ssl
import stat
import tempfile

spec=importlib.util.spec_from_file_location('publisher',pathlib.Path(__file__).with_name('server-certificate-publisher.py'))
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
R=publisher.transport
Error=R.CertificateError
UTC=dt.timezone.utc


def validate_authority(authority):
    ca=R.private_path(authority['certificateFile'])
    if ca.stat().st_uid!=0:raise Error('unsafe_authority_file')
    key=R.private_path(authority['privateKeyFile'],root_only=True)
    if R.certificate_hash(ca)!=authority['certificateSha256'] or R.public_key_hash(ca)!=R.public_key_hash(key,False):
        raise Error('authority_identity_changed')
    if R.expires(ca)<=dt.datetime.now(UTC)+dt.timedelta(days=31):
        raise Error('authority_expiring')
    return ca,key


def issue_leaf(source, destination, authority):
    ca,key=validate_authority(authority)
    # Re-sign the public leaf while preserving its subject, key and extensions.
    # No CSR or private key from the server is required or transported.
    R.command(['x509','-in',str(source),'-CA',str(ca),'-CAkey',str(key),'-days','30',
        '-set_serial','0x'+os.urandom(16).hex(),'-out',str(destination)])
    destination.chmod(0o600)


def request(config, method, body=None, client_certificate=None, connection_factory=http.client.HTTPSConnection):
    maintenance=config['maintenance']
    context=ssl.create_default_context(cafile=config['authority']['certificateFile'])
    context.minimum_version=ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(client_certificate or maintenance['certificateFile'],maintenance['privateKeyFile'])
    connection=connection_factory('13.39.100.55',8450,context=context,timeout=85)
    try:
        path='/healthz' if method=='GET' else '/v1/certificates/publish'
        raw=None if body is None else json.dumps(body,separators=(',',':'))
        connection.request(method,path,raw,{'Content-Type':'application/json'} if body is not None else {})
        response=connection.getresponse();data=response.read(8193)
        if len(data)>8192:
            raise Error('publisher_response_invalid')
        value=json.loads(data)
        if response.status!=200:
            raise Error('publisher_rejected_certificate')
        return value
    finally:
        connection.close()


def renew_maintenance(config, send=request, force=False):
    maintenance=config['maintenance'];ca,_=validate_authority(config['authority'])
    cert=R.private_path(maintenance['certificateFile'],root_only=True)
    key=R.private_path(maintenance['privateKeyFile'],root_only=True)
    if R.public_key_hash(cert)!=maintenance['publicKeySha256'] or R.public_key_hash(key,False)!=maintenance['publicKeySha256'] \
      or publisher.identity(cert)!=maintenance['identitySha256']:
        raise Error('maintenance_identity_changed')
    if not force and R.expires(cert)>dt.datetime.now(UTC)+dt.timedelta(days=10):
        if send(config,'GET')!={'status':'ready'}:
            raise Error('maintenance_identity_rejected')
        return {'id':'maintenance-client','status':'healthy','expiresAt':R.expires(cert).isoformat()}
    before=cert.read_bytes()
    with tempfile.TemporaryDirectory(prefix='client-issue-',dir=config['stateDirectory']) as temp:
        candidate=pathlib.Path(temp)/'client.crt';issue_leaf(cert,candidate,config['authority'])
        R.command(['verify','-purpose','sslclient','-CAfile',str(ca),str(candidate)])
        if publisher.identity(candidate)!=maintenance['identitySha256'] or R.public_key_hash(candidate)!=maintenance['publicKeySha256']:
            raise Error('maintenance_identity_changed')
        if send(config,'GET',client_certificate=str(candidate))!={'status':'ready'}:
            raise Error('maintenance_identity_rejected')
        if cert.read_bytes()!=before:
            raise Error('concurrent_certificate_change')
        R.atomic_write(pathlib.Path(config['stateDirectory'])/('maintenance-client-'+R.certificate_hash(cert)+'.crt'),before)
        R.atomic_write(cert,candidate.read_bytes())
        try:
            if send(config,'GET')!={'status':'ready'}:
                raise Error('maintenance_identity_rejected')
        except Exception:
            R.atomic_write(cert,before);raise Error('maintenance_renewal_rolled_back')
    return {'id':'maintenance-client','status':'renewed','expiresAt':R.expires(cert).isoformat()}


def fetch_leaf(config,target):
    context=ssl.create_default_context(cafile=config['authority']['certificateFile'])
    context.minimum_version=ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(config['maintenance']['certificateFile'],config['maintenance']['privateKeyFile'])
    with socket.create_connection(('13.39.100.55',target['port']),timeout=5) as sock:
        with context.wrap_socket(sock,server_hostname='13.39.100.55') as connection:
            return ssl.DER_cert_to_PEM_cert(connection.getpeercert(binary_form=True)).encode()


def renew_server(config,target,send=request,fetch=fetch_leaf,force=False):
    with tempfile.TemporaryDirectory(prefix='server-issue-',dir=config['stateDirectory']) as temp:
        current=pathlib.Path(temp)/'current.crt';current.write_bytes(fetch(config,target));current.chmod(0o600)
        publisher.validate_leaf(current,target,config['authority']['certificateFile'])
        before_hash=R.certificate_hash(current)
        if not force and R.expires(current)>dt.datetime.now(UTC)+dt.timedelta(days=10):
            return {'id':target['id'],'status':'healthy','expiresAt':R.expires(current).isoformat(),'fingerprint':before_hash}
        candidate=pathlib.Path(temp)/'candidate.crt';issue_leaf(current,candidate,config['authority'])
        expiration=publisher.validate_leaf(candidate,target,config['authority']['certificateFile'])
        digest=R.certificate_hash(candidate)
        result=send(config,'POST',{'id':target['id'],'certificate':candidate.read_text()})
        if result!={'id':target['id'],'status':'renewed','fingerprint':digest,'expiresAt':expiration.isoformat()}:
            raise Error('publisher_receipt_invalid')
        # Verify from ClinicaClick too; remote success alone does not prove the
        # new certificate is accepted by a real client on this network path.
        after=pathlib.Path(temp)/'served.crt';after.write_bytes(fetch(config,target));after.chmod(0o600)
        publisher.validate_leaf(after,target,config['authority']['certificateFile'])
        if R.certificate_hash(after)!=digest:
            raise Error('renewed_server_not_observed')
        R.atomic_write(pathlib.Path(config['stateDirectory'])/(target['id']+'-'+before_hash+'.crt'),current.read_bytes())
        return result


def configuration(filename):
    config=json.loads(R.private_path(filename,root_only=True).read_bytes())
    if set(config)!={'version','authority','maintenance','targets','stateDirectory','statusFile','statusGroupId'} or config['version']!=1:
        raise Error('configuration_invalid')
    if set(config['authority'])!={'certificateFile','privateKeyFile','certificateSha256'} \
      or set(config['maintenance'])!={'certificateFile','privateKeyFile','publicKeySha256','identitySha256'} \
      or not isinstance(config['statusGroupId'],int) or config['statusGroupId']<0:
        raise Error('configuration_invalid')
    for obj in [config['authority'],config['maintenance']]:
        for k,v in obj.items():
            if k.endswith('File'):
                public_ca=obj is config['authority'] and k=='certificateFile'
                p=R.private_path(v,root_only=not public_ca)
                if p.stat().st_uid!=0:raise Error('unsafe_authority_file')
            elif not re.fullmatch('[a-f0-9]{64}',v):raise Error('configuration_invalid')
    # Check even when all leaves are fresh and no signing will take place.
    validate_authority(config['authority'])
    state=pathlib.Path(config['stateDirectory'])
    if not state.is_absolute() or state.resolve()!=state:
        raise Error('unsafe_state_directory')
    state.mkdir(mode=0o700,parents=True,exist_ok=True)
    if state.stat().st_uid!=0 or stat.S_IMODE(state.stat().st_mode)!=0o700:
        raise Error('unsafe_state_directory')
    if config['statusFile']!='/var/lib/clinicaclick-transport-health/servers.json':
        raise Error('configuration_invalid')
    ids=set();ports=set()
    if not 1<=len(config['targets'])<=13:raise Error('configuration_invalid')
    for t in config['targets']:
        if set(t)!={'id','hostname','port','publicKeySha256','identitySha256'} \
          or not re.fullmatch('[a-z][a-z0-9-]{1,39}',t['id']) or t['hostname']!='13.39.100.55' \
          or not publisher.target_port_valid(t) \
          or any(not re.fullmatch('[a-f0-9]{64}',t[k]) for k in ['publicKeySha256','identitySha256']) \
          or t['id'] in ids or t['port'] in ports:raise Error('configuration_invalid')
        ids.add(t['id']);ports.add(t['port'])
    return config


def main():
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--force-id')
    args=parser.parse_args()
    if os.geteuid()!=0:raise Error('root_required')
    config=configuration(args.config)
    if args.force_id and args.force_id not in {'maintenance-client',*[t['id'] for t in config['targets']]}:
        raise Error('unknown_certificate')
    with (pathlib.Path(config['stateDirectory'])/'renew.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        results=[]
        try:results.append(renew_maintenance(config,force=args.force_id=='maintenance-client'))
        except Exception:results.append({'id':'maintenance-client','status':'failed','reason':'maintenance_identity_failed'})
        for target in config['targets']:
            try:results.append(renew_server(config,target,force=args.force_id==target['id']))
            except Exception as e:results.append({'id':target['id'],'status':'failed','reason':str(e) if isinstance(e,Error) else 'server_check_failed'})
        result={'version':1,'checkedAt':dt.datetime.now(UTC).isoformat(),
            'expectedIds':['maintenance-client']+[t['id'] for t in config['targets']],
            'certificates':results}
        R.atomic_write(config['statusFile'],json.dumps(result).encode(),0o640,0,config['statusGroupId'])
        print(json.dumps(result));return int(any(r['status']=='failed' for r in results))


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print(json.dumps({'status':'failed','reason':'server_certificate_maintenance_failed'}));raise SystemExit(1)
