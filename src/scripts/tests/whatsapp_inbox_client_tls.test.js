'use strict';
// Runs on the application's Node 18 as well as the broker's newer runtime.
// Synthetic TLS only: no SQLite, AWS, database, provider or application bootstrap.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),https=require('node:https');
const {execFileSync}=require('node:child_process');
const {createInboxClient}=require('../../lib/whatsappInboxClient');
test('application runtime reloads a same-identity certificate and keeps it when the next key differs',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-inbox-client-tls-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=n=>path.join(dir,n),read=n=>fs.readFileSync(file(n));
  const openssl=args=>execFileSync('/usr/bin/openssl',args,{stdio:'ignore',cwd:dir});
  fs.writeFileSync(file('ca.conf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','365','-subj','/CN=QA_CA','-config','ca.conf']);
  for(const name of ['server','client']){
    fs.writeFileSync(file(name+'.ext'),'basicConstraints=critical,CA:FALSE\nextendedKeyUsage='+(name==='server'?'serverAuth\nsubjectAltName=IP:127.0.0.1':'clientAuth')+'\n');
    openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=QA_'+name]);
    openssl(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial',name==='server'?'1':'2','-days','10','-extfile',name+'.ext','-out',name+'.crt']);
  }
  const server=https.createServer({key:read('server.key'),cert:read('server.crt'),ca:read('ca.crt'),requestCert:true,rejectUnauthorized:true},(req,res)=>{
    assert.equal(req.url,'/v1/whatsapp/inbox/pending');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({serial:req.socket.getPeerCertificate().serialNumber}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const events=[];const client=createInboxClient({origin:'https://127.0.0.1:'+server.address().port,
    ca:read('ca.crt'),cert:read('client.crt'),key:read('client.key'),readCertificate:()=>read('client.crt'),report:e=>events.push(e)});
  t.after(()=>client.close());
  assert.equal((await client.request('GET','/pending')).data.serial,'02');
  openssl(['x509','-req','-in','client.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial','3','-days','30','-extfile','client.ext','-out','client.crt']);
  assert.equal((await client.request('GET','/pending')).data.serial,'03');
  assert.equal(events.at(-1).status,'reloaded');
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout','wrong.key','-out','wrong.csr','-subj','/CN=QA_client']);
  openssl(['x509','-req','-in','wrong.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial','4','-days','30','-extfile','client.ext','-out','client.crt']);
  assert.equal((await client.request('GET','/pending')).data.serial,'03');
  assert.equal(events.at(-1).status,'reload_failed');
});
