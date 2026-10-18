'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const tls=require('node:tls');
const {X509Certificate}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {databaseConfiguration}=require('../whatsapp-inbox-consumer');
const base={DB_HOST:'127.0.0.1',DB_NAME:'clinicaclick',DB_USERNAME:'fixture_importer',DB_PASSWORD:'FICTITIOUS_PASSWORD_SENTINEL'};
let root,caFile,serverFile;
test.before(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'cc-inbox-tls-'));fs.chmodSync(root,0o700);
  caFile=path.join(root,'ca.pem');serverFile=path.join(root,'server.pem');
  const run=args=>execFileSync('openssl',args,{stdio:'ignore'});
  fs.writeFileSync(path.join(root,'ca.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  run(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Fictitious importer CA',
    '-config',path.join(root,'ca.cnf'),'-keyout',path.join(root,'ca.key'),'-out',caFile]);
  run(['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=rds.fixture.invalid',
    '-keyout',path.join(root,'server.key'),'-out',path.join(root,'server.csr')]);
  fs.writeFileSync(path.join(root,'server.ext'),'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:rds.fixture.invalid\nextendedKeyUsage=serverAuth\n');
  run(['x509','-req','-days','1','-in',path.join(root,'server.csr'),'-CA',caFile,'-CAkey',path.join(root,'ca.key'),
    '-CAcreateserial','-extfile',path.join(root,'server.ext'),'-out',serverFile]);
});
test.after(()=>{if(root)fs.rmSync(root,{recursive:true,force:true});});
test('existing local transport remains available, without loading production models',()=>{
  assert.equal(require.cache[require.resolve('../../../models')],undefined);
  for(const DB_HOST of ['127.0.0.1','localhost','::1']){
    const options=databaseConfiguration({...base,DB_HOST});
    assert.equal(options.host,DB_HOST);assert.equal(options.port,3306);assert.equal(options.ssl,undefined);
    assert.equal(options.connectTimeout,3000);assert.equal(options.timezone,'Z');
  }
});
test('remote database never permits plaintext or malformed configuration',()=>{
  for(const DB_TLS_REQUIRED of [undefined,'','false'])assert.throws(()=>databaseConfiguration({...base,DB_HOST:'rds.fixture.invalid',DB_TLS_REQUIRED}),/database_remote_tls_required/);
  for(const DB_HOST of ['',undefined,'rds.fixture.invalid/path','user@rds.fixture.invalid','-rds.invalid','rds.invalid\n'])assert.throws(()=>databaseConfiguration({...base,DB_HOST}),/inbox_database_configuration_invalid/);
  for(const DB_PORT of ['0','65536','3306junk','3e3','-1'])assert.throws(()=>databaseConfiguration({...base,DB_PORT}),/inbox_database_configuration_invalid/);
  for(const changed of [{DB_USERNAME:''},{DB_PASSWORD:''},{DB_NAME:'other_database'}])assert.throws(()=>databaseConfiguration({...base,...changed}),error=>error.message==='inbox_database_configuration_invalid'&&!error.message.includes('FICTITIOUS_PASSWORD_SENTINEL'));
});
test('required TLS rejects bad flags, missing/untrusted material and private keys without fallback',()=>{
  const remote={...base,DB_HOST:'rds.fixture.invalid',DB_TLS_REQUIRED:'true'};
  assert.throws(()=>databaseConfiguration({...remote,DB_TLS_REQUIRED:'TRUE'}),/database_tls_mode_invalid/);
  for(const DB_TLS_CA_FILE of [undefined,'./ca.pem'])assert.throws(()=>databaseConfiguration({...remote,DB_TLS_CA_FILE}),/database_tls_ca_required/);
  for(const DB_TLS_CA_FILE of [path.join(root,'absent.pem'),path.join(root,'ca.key'),serverFile])assert.throws(()=>databaseConfiguration({...remote,DB_TLS_CA_FILE}),error=>error.message==='database_tls_ca_invalid'&&!error.message.includes('FICTITIOUS_PASSWORD_SENTINEL'));
});
test('remote TLS carries the trusted CA, strict hostname checks and TLS1.2 minimum',()=>{
  const options=databaseConfiguration({...base,DB_HOST:'rds.fixture.invalid',DB_PORT:'3306',DB_TLS_REQUIRED:'true',DB_TLS_CA_FILE:caFile});
  assert.deepEqual(options.ssl.ca,fs.readFileSync(caFile));
  assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.verifyIdentity,true);assert.equal(options.ssl.minVersion,'TLSv1.2');
  const certificate=new X509Certificate(fs.readFileSync(serverFile));
  assert.equal(certificate.verify(new X509Certificate(fs.readFileSync(caFile)).publicKey),true);
  assert.equal(tls.checkServerIdentity(options.host,certificate.toLegacyObject()),undefined);
  assert.equal(tls.checkServerIdentity('other-rds.fixture.invalid',certificate.toLegacyObject()).code,'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(tls.checkServerIdentity('127.0.0.1',certificate.toLegacyObject()).code,'ERR_TLS_CERT_ALTNAME_INVALID');
});
