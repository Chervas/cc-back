'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { allowPort, removePort } = require('./offline-guard.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cc-onboarding-transport-'));
  const { generateKeyPairSync, randomUUID } = require('node:crypto');
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  return {dir, keys:generateKeyPairSync('ed25519'), policy:{audience:'broker:test'}, command:(values={})=>({requestId:randomUUID(),operation:'fictitious.connection.check.v1',connectionRef:'connection:test',assetRef:'asset:456',tenantRef:'clinic:123',payload:{},...values})};
}
test('backend absolute deadline bounds a TLS response that keeps sending bytes', async t => {
  const f = fixture(t); const cert = path.join(f.dir, 'deadline.crt'); const key = path.join(f.dir, 'deadline.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = require('node:https').createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
    const timer = setInterval(() => res.write(' '), 5); res.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; allowPort(port);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); removePort(port); });
  const client = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience,
    keyId: 'qa-key', privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert), timeoutMs: 1000 });
  for (const timeoutMs of [0, -1, 30001, Infinity, '50']) await assert.rejects(client.execute(f.command(), { timeoutMs }), { code: 'invalid_request' });
  await assert.rejects(client.execute(f.command(), { timeoutMs: 50 }), { code: 'broker_timeout' });
});

test('extended onboarding transport is restricted to activation and keeps reads on their short budget',async t=>{
  const f=fixture(t),cert=path.join(f.dir,'activation.crt'),key=path.join(f.dir,'activation.key');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  let calls=0;const server=createServer({async execute(raw){calls++;const body=JSON.parse(raw);return {requestId:body.requestId,replayed:false,data:{state:'active'}};}},{cert:fs.readFileSync(cert),key:fs.readFileSync(key)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;allowPort(port);
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));removePort(port);});
  const options={origin:`https://127.0.0.1:${port}`,audience:f.policy.audience,keyId:'qa-key',privateKey:f.keys.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cert),timeoutMs:100000};
  assert.throws(()=>createIntegrationsBrokerClient(options),/broker_configuration_invalid/);
  const client=createIntegrationsBrokerClient({...options,transportProfile:'whatsapp-onboarding'});
  const command=f.command({operation:'meta.whatsapp.onboarding.activate.v1'});
  assert.equal((await client.execute(command)).data.state,'active');
  await assert.rejects(client.execute(command,{timeoutMs:100001}),{code:'invalid_request'});
  await assert.rejects(client.execute({...command,operation:'meta.whatsapp.onboarding.profile.v1'},{timeoutMs:35000}),{code:'invalid_request'});
  await assert.rejects(client.execute({...command,operation:'meta.whatsapp.authorized.send.v1'}),{code:'invalid_request'});
  await client.execute({...command,operation:'meta.whatsapp.onboarding.profile.v1'});
  assert.equal(calls,2);
});
