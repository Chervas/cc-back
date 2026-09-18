'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const https = require('node:https'); const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process'); const { X509Certificate } = require('node:crypto');
const R = require('../src/tls-reload'); const { allowPort, removePort } = require('./offline-guard.cjs');
const openssl = args => execFileSync('openssl', args, { stdio: 'ignore' });
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'cc-tls-renewal-')); fs.chmodSync(dir,0o700);
  const file = name => path.join(dir,name); let serial = 1;
  fs.writeFileSync(file('ca.cnf'),'[req]\ndistinguished_name=dn\n[dn]\n');
  const ca = name => openssl(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes',
    '-config',file('ca.cnf'),'-keyout',file(name+'.key'),'-out',file(name+'.crt'),'-days','365','-subj','/CN=FICTITIOUS_'+name,
    '-addext','basicConstraints=critical,CA:TRUE']);
  ca('ca'); ca('other-ca');
  for (const name of ['server','different-key']) openssl(['genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-out',file(name+'.key')]);
  function leaf(name, { key='server',issuer='ca',san='IP:127.0.0.1',subject='server',eku='serverAuth',days='20',isCa=false }={}) {
    fs.writeFileSync(file('extensions'),`basicConstraints=critical,CA:${isCa?'TRUE':'FALSE'}\nsubjectAltName=${san}\nextendedKeyUsage=${eku}\n`);
    openssl(['req','-new','-key',file(key+'.key'),'-out',file('request.csr'),'-subj','/CN=FICTITIOUS_'+subject]);
    openssl(['x509','-req','-in',file('request.csr'),'-CA',file(issuer+'.crt'),'-CAkey',file(issuer+'.key'),
      '-set_serial',String(serial++),'-out',file(name+'.crt'),'-days',days,'-extfile',file('extensions')]);
    fs.chmodSync(file(name+'.crt'),0o600); return fs.readFileSync(file(name+'.crt'));
  }
  const original = leaf('server'); const initial = {key:fs.readFileSync(file('server.key')),cert:original};
  for (const name of fs.readdirSync(dir)) fs.chmodSync(file(name),0o600);
  const config = {tlsKeyFile:file('server.key'),tlsCertFile:file('server.crt'),tlsRenewal:{issuerCaFile:file('ca.crt')}};
  let release; let arrived;
  const reached = new Promise(resolve=>{arrived=resolve;}); const blocked = new Promise(resolve=>{release=resolve;});
  const server = https.createServer(initial,async(req,res)=>{if(req.url==='/held'){arrived();await blocked;} res.end('FICTITIOUS_OK');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const port=server.address().port; allowPort(port);
  const signals=new EventEmitter(); const events=[]; let clock=null;
  let maintenance;
  t.after(async()=>{release();maintenance?.close();await new Promise(resolve=>server.close(resolve));removePort(port);fs.rmSync(dir,{recursive:true,force:true});});
  maintenance=R.install(server,config,initial,{signals,report:event=>events.push(event),now:()=>clock??Date.now()});
  const get=(route='/')=>new Promise((resolve,reject)=>{
    const req=https.get({host:'127.0.0.1',port,path:route,ca:fs.readFileSync(file('ca.crt')),agent:false},res=>{
      const fingerprint=res.socket.getPeerCertificate().fingerprint256; let body='';
      res.on('data',c=>body+=c);res.on('end',()=>resolve({fingerprint,body}));
    }); req.on('error',reject);
  });
  const put=pem=>{fs.writeFileSync(file('next.crt'),pem,{mode:0o600});fs.renameSync(file('next.crt'),file('server.crt'));};
  return {file,leaf,original,put,maintenance,server,get,reached,release,signals,events,config,initial,setClock:value=>{clock=value;}};
}
test('audit and integrations ship the same standalone TLS reloader',()=>{
  assert.equal(fs.readFileSync(path.join(__dirname,'../src/tls-reload.js'),'utf8'),
    fs.readFileSync(path.join(__dirname,'../../platform-audit/src/tls-reload.js'),'utf8'));
});
test('renewal changes new TLS handshakes without interrupting an in-flight request; rollback is possible',async t=>{
  const f=await fixture(t);const before=await f.get();const held=f.get('/held');await f.reached;
  const next=f.leaf('next');f.put(next);assert.equal(f.maintenance.reload(),true);
  const after=await f.get();assert.equal(after.body,'FICTITIOUS_OK');assert.notEqual(after.fingerprint,before.fingerprint);
  f.release();assert.deepEqual(await held,before);
  f.put(f.original);f.signals.emit('SIGHUP');assert.equal((await f.get()).fingerprint,before.fingerprint);
  assert.equal(f.events.filter(e=>e.status==='reloaded').length,2);
  f.maintenance.close();assert.equal(f.signals.listenerCount('SIGHUP'),0);assert.equal(f.maintenance.reload(),false);
});
test('wrong key, CA, subject, SAN, usage and near-expiry keep the live certificate',async t=>{
  const f=await fixture(t);const before=await f.get();
  for(const options of [{key:'different-key'},{issuer:'other-ca'},{subject:'intruder'},{san:'IP:127.0.0.2'},
    {eku:'serverAuth,clientAuth'},{isCa:true},{days:'0'}]){
    f.put(f.leaf('bad',options));assert.equal(f.maintenance.reload(),false,JSON.stringify(options));
    assert.deepEqual(await f.get(),before);
  }
  f.put(Buffer.from('INVALID_PRIVATE_DATA_SHOULD_NEVER_APPEAR_IN_LOGS'));
  assert.equal(f.maintenance.reload(),false);assert(!JSON.stringify(f.events).includes('INVALID_PRIVATE_DATA'));
  assert.equal(f.events.length,1,'repeated failures are deduplicated');
  f.put(f.leaf('recovered'));assert.equal(f.maintenance.reload(),true);assert.equal(f.events.at(-1).status,'reloaded');
});
test('future certificates, expired issuers and unsafe replacement files are refused',async t=>{
  const f=await fixture(t);const candidate=f.leaf('candidate');const certificate=new X509Certificate(candidate);
  f.put(candidate);f.setClock(certificate.validFromDate.getTime()-1000);assert.equal(f.maintenance.reload(),false);
  f.setClock(Date.now()+366*86400000);assert.equal(f.maintenance.reload(),false);f.setClock(Date.now());
  fs.chmodSync(f.file('server.crt'),0o644);assert.equal(f.maintenance.reload(),false);
  fs.unlinkSync(f.file('server.crt'));fs.symlinkSync(f.file('candidate.crt'),f.file('server.crt'));assert.equal(f.maintenance.reload(),false);
  fs.unlinkSync(f.file('server.crt'));fs.linkSync(f.file('candidate.crt'),f.file('server.crt'));assert.equal(f.maintenance.reload(),false);
  fs.unlinkSync(f.file('server.crt'));f.put(candidate);assert.equal(f.maintenance.reload(),true);
});
test('disabled configuration installs no timer or signal and malformed settings fail before activation',()=>{
  const signals=new EventEmitter();assert.equal(R.install({}, {}, {}, {signals}),null);assert.equal(signals.listenerCount('SIGHUP'),0);
  for(const settings of [null,{}, {issuerCaFile:'relative'}, {issuerCaFile:'/tmp/a',execute:'anything'}])
    assert.throws(()=>R.validateSettings(settings));
});
