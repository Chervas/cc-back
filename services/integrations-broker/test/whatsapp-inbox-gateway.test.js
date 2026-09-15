'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');const {X509Certificate,randomBytes,createHmac}=require('node:crypto');
const {createInboxServer}=require('../src/whatsapp-inbox-server');const {createInboxCipher,createWhatsappInbox}=require('../src/whatsapp-inbox');const {BrokerStore}=require('../src/store');
const {createInboxClient}=require('../../../src/lib/whatsappInboxClient');const {createGatewayHandler}=require('../../../src/lib/whatsappInboxGateway');const {allowPort,removePort}=require('./offline-guard.cjs');
test('public raw bridge preserves signed bytes, waits for durable receipt and retries failures; consumer certificate is separate',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-inbox-bridge-'));fs.chmodSync(dir,0o700);const run=args=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=QA_INBOX_CA']);
 const identities={};
 for(const name of ['server','gateway','staging']){
  fs.writeFileSync(path.join(dir,name+'.ext'),name==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth':'extendedKeyUsage=clientAuth');
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=QA_'+name]);
  run(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',name+'.crt','-days','1','-extfile',name+'.ext']);
  identities[name]={key:fs.readFileSync(path.join(dir,name+'.key')),cert:fs.readFileSync(path.join(dir,name+'.crt'))};
 }
 const ca=fs.readFileSync(path.join(dir,'ca.crt'));const key=randomBytes(32);const cipher=createInboxCipher({key,keyId:'QA_KEY'});key.fill(0);
 const store=new BrokerStore(path.join(dir,'inbox.db'));const inbox=createWhatsappInbox({store,cipher,appId:'101',bindings:[{wabaId:'301',phoneIds:['401']}],auditContext:{tenantRef:'clinic:71',connectionRef:'connection:qa',resourceRef:'wa-inbox:101',operation:'whatsapp.webhook.capture',policyVersion:'qa-v1'}});
 const secret=Buffer.from('0123456789abcdef0123456789abcdef');let unavailable=false;
 const server=createInboxServer({inbox,withApplicationSecret:async work=>{if(unavailable)throw Error('fake_failure');return work(secret);},...identities.server,ca,consumerEnabled:true,
  principals:['gateway','staging'].map(n=>({id:n+':whatsapp-inbox',certificateSha256:new X509Certificate(identities[n].cert).fingerprint256.replaceAll(':','').toLowerCase(),maxPerMinute:600}))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;allowPort(port);
 const origin='https://127.0.0.1:'+port;const gateway=createInboxClient({origin,ca,...identities.gateway});const staging=createInboxClient({origin,ca,...identities.staging});
 const bridge=http.createServer(createGatewayHandler(gateway));await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const publicPort=bridge.address().port;allowPort(publicPort);
 t.after(async()=>{gateway.close();staging.close();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>bridge.close(r))]);store.close();cipher.close();secret.fill(0);removePort(port);removePort(publicPort);fs.rmSync(dir,{recursive:true,force:true});});
 const raw=Buffer.from('{ "object":"whatsapp_business_account", "entry":[{"id":"301","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"401"},"messages":[]}}]}] }');
 const signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
 const send=(body=raw,sig=signature)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:publicPort,path:'/api/whatsapp/webhook',method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':sig}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),retry:res.headers['retry-after']}));});req.on('error',reject);req.end(body);});
 assert.equal((await send()).status,200);assert.equal((await send()).status,200);assert.equal(inbox.pending().length,1);
 assert.equal((await gateway.request('GET','/pending')).status,403);
 const listed=await staging.request('GET','/pending');assert.equal(listed.data.receipts.length,1);
 const leased=await staging.request('POST','/lease',{receipt:listed.data.receipts[0].receipt});assert.deepEqual(Buffer.from(leased.data.rawBase64,'base64'),raw);
 assert.equal((await send(Buffer.from(raw.toString().replace('"messages":[]','"messages":[{}]')))).status,401);
 unavailable=true;const outage=await send();assert.equal(outage.status,503);assert.equal(outage.retry,'60');
 const ack=await staging.request('POST','/confirm',{receipt:leased.data.receipt,lease:leased.data.lease,importReceipt:require('node:crypto').randomUUID()});assert.equal(ack.data.businessProcessed,true);
});
