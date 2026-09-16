'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'); const { fixture, template, textMessage, templateMessage } = require('./whatsapp-authorized-fixture.cjs');
const C = require('../src/whatsapp-authorized-contract'); const { validateAuthorization } = require('../src/whatsapp-authorized-registry');
test('Disabled is the default and blocks before any candidate read or Meta call', async t => {
  const a=await fixture(t,{enabled:false}); const v={...a.definition};delete v.enabled;assert.equal(validateAuthorization(v).enabled,false);
  const count=a.f.state.awsCalls.length;await assert.rejects(a.execute(),{code:'connection_blocked'});assert.equal(a.f.state.awsCalls.length,count);assert.equal(a.state.calls.length,0);
});
test('Same verified BISU candidate sends selected phone, preserving held status without credential copying or ledger mutation',async t=>{
  const a=await fixture(t);const before=a.f.snapshot();const puts=a.f.state.puts;a.state.response.messages[0].message_status='held_for_quality_assessment';
  const result=await a.execute();assert.deepEqual(result.data,{messages:[{id:'wamid.FICTITIOUS_QA',message_status:'held_for_quality_assessment'}]});
  assert.equal(a.f.state.puts,puts);assert.equal(a.f.snapshot(),before);assert.equal(a.sends().length,1);assert.equal(a.sends()[0].id,'401');
  for(const token of a.f.state.heldTokens)assert(token.every(v=>v===0));
  assert.deepEqual(a.state.calls.map(c=>c.action), ['send']);
});
test('Staged credential survives the completed OAuth window but not operational expiry',async t=>{
  const a=await fixture(t);a.f.state.clock+=660000;await a.execute();a.f.state.clock=a.definition.expiresAt;
  await assert.rejects(a.execute(),{code:'connection_blocked'});assert.equal(a.sends().length,1);
});
test('Ongoing grants survive the pilot deadline and restart while keeping scope revocation effective',async t=>{
 const a=await fixture(t,{ongoing:true});a.f.state.clock+=366*86400000;
 await a.execute();a.restart();await a.execute();assert.equal(a.sends().length,2);
 assert.deepEqual(a.state.calls.map(c=>c.action),['send','send']);
 a.blockScope();a.restart();await assert.rejects(a.execute(),{code:'asset_revoked'});
 assert.equal(a.sends().length,2);
});
for(const field of ['expiresAt','dataAccessExpiresAt'])test('Ongoing local grant still respects provider '+field,async t=>{
 const a=await fixture(t,{ongoing:true});const db=a.f.current.store.db;
 const meta=JSON.parse(db.prepare('SELECT credential_metadata FROM whatsapp_onboarding_flows WHERE id=?').get(a.definition.authorizationId).credential_metadata);
 meta[field]=a.f.now()+1000;db.prepare('UPDATE whatsapp_onboarding_flows SET credential_metadata=? WHERE id=?').run(JSON.stringify(meta),a.definition.authorizationId);
 a.f.state.clock+=1001;
 await assert.rejects(a.execute(),{code:'credential_revoked'});assert.equal(a.sends().length,0);
});
test('Foreign clinic, phone, authorization or principal cannot reach secrets',async t=>{
  const a=await fixture(t);const base=a.request();const before=a.f.state.awsCalls.length;
  for(const value of [{...base,tenantRef:'clinic:73'},{...base,assetRef:'wa-phone:999'},{...base,payload:{...base.payload,phoneId:'999'}},
    {...base,payload:{...base.payload,authorizationId:randomUUID()}}])await assert.rejects(a.execute(value),{code:'scope_denied'});
  await assert.rejects(a.execute(base,true),{code:'scope_denied'});assert.equal(a.f.state.awsCalls.length,before);assert.equal(a.sends().length,0);
});
for(const mutation of ['awaiting','aborted','digest','phone_reservation','configuration','connection','scope','asset','credential_expiry'])test('Ledger '+mutation+' prevents use before credentials',async t=>{
  const a=await fixture(t);const db=a.f.current.store.db;const id=a.definition.authorizationId;
  if(['awaiting','aborted'].includes(mutation))db.prepare('UPDATE whatsapp_onboarding_flows SET state=? WHERE id=?').run(mutation,id);
  if(mutation==='digest')db.prepare('UPDATE whatsapp_onboarding_flows SET secret_digest=? WHERE id=?').run('0'.repeat(64),id);
  if(mutation==='phone_reservation')db.prepare('UPDATE whatsapp_onboarding_assets SET clinic_digest=?').run('0'.repeat(64));
  if(mutation==='configuration')a.f.binding.whatsappOnboarding.configId='999';
  if(mutation==='connection')db.prepare("UPDATE connections SET state='blocked'").run();
  if(mutation==='scope')a.blockScope();
  if(mutation==='asset')db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:71',a.f.binding.connectionRef,'wa-enroll:group:9',randomUUID(),a.f.now());
  if(mutation==='credential_expiry'){const row=db.prepare('SELECT credential_metadata FROM whatsapp_onboarding_flows WHERE id=?').get(id);const value=JSON.parse(row.credential_metadata);value.expiresAt=a.f.now()-1;db.prepare('UPDATE whatsapp_onboarding_flows SET credential_metadata=? WHERE id=?').run(JSON.stringify(value),id);}
  const before=a.f.state.awsCalls.length;await assert.rejects(a.execute());assert.equal(a.f.state.awsCalls.length,before);assert.equal(a.sends().length,0);
});
for(const mutation of ['digest','AWSCURRENT','AWSPREVIOUS'])test('Candidate '+mutation+' cannot be promoted or substituted',async t=>{
  const a=await fixture(t);const record=a.f.records.get(a.f.binding.secretArn).get(a.definition.authorizationId);
  if(mutation==='digest')record.body=record.body.replace('FICTITIOUS_ONBOARDING_TOKEN','FICTITIOUS_OTHER_TOKEN');else record.stages=[mutation];
  await assert.rejects(a.execute());assert.equal(a.sends().length,0);
});
test('Immutable version may lose AWSPENDING label without becoming another candidate',async t=>{
  const a=await fixture(t);a.f.records.get(a.f.binding.secretArn).get(a.definition.authorizationId).stages=[];await a.execute();assert.equal(a.sends().length,1);
});
test('Image header, BODY values, QUICK_REPLY and dynamic URL buttons preserve their real Graph message',async t=>{
  const a=await fixture(t);const message=templateMessage();await a.execute(a.request(message));assert.deepEqual(a.sends()[0].json,message);
  assert.deepEqual(a.state.calls.map(c=>c.action), ['send']);
});
test('Template status and parameter interpretation remain the responsibility of Meta',async t=>{
  const a=await fixture(t);a.state.remoteTemplate.status='PENDING';
  const message=templateMessage();message.template.components=message.template.components.filter(c=>c.type!=='button');
  await a.execute(a.request(message));assert.equal(a.sends().length,1);
  assert.deepEqual(a.state.calls.map(c=>c.action), ['send']);
});
test('Typed interactive CTA remains supported with fixed sender',async t=>{
  const a=await fixture(t);const message={messaging_product:'whatsapp',to:'34000000123',type:'interactive',interactive:{type:'cta_url',body:{text:'QA'},action:{name:'cta_url',parameters:{display_text:'Abrir',url:'https://clinic.example.invalid/qa'}}}};
  await a.execute(a.request(message));assert.deepEqual(a.sends()[0].json,message);
});
test('Malformed message, token, endpoint and unsupported operations are rejected by schema',()=>{
  for(const message of [{...textMessage(),access_token:'FICTITIOUS'}, {...textMessage(),type:'reaction'}, {...textMessage(),text:{body:'QA',url:'https://other.invalid/'}},
    {...templateMessage(),template:{...templateMessage().template,components:[{type:'header',parameters:[{type:'image',image:{link:'http://other.invalid/x'}}]}]}}])assert.throws(()=>C.validateMessage(message),{code:'invalid_request'});
});
test('Completed receipt replay after restart makes no new call and a later revocation blocks even replay',async t=>{
  const a=await fixture(t);const request=a.request();const result=await a.execute(request);const calls=a.state.calls.length;const reads=a.f.state.awsCalls.length;
  a.restart();const replay=await a.execute(request);assert.equal(replay.replayed,true);assert.deepEqual(replay.data,result.data);assert.equal(a.state.calls.length,calls);assert.equal(a.f.state.awsCalls.length,reads);
  a.blockScope();await assert.rejects(a.execute(request),{code:'asset_revoked'});assert.equal(a.sends().length,1);
});
test('Lost provider response remains unknown across retries and restart, with no second POST',async t=>{
  const a=await fixture(t);const request=a.request();a.state.after=(r,v)=>{if(r.action==='send')throw Error('FICTITIOUS_RESPONSE_LOST');return v;};
  await assert.rejects(a.execute(request));a.restart();await assert.rejects(a.execute(request),{code:'outcome_unknown'});assert.equal(a.sends().length,1);
});
test('Control revocation is durable and scoped to the selected clinic even for a shared phone',async t=>{
  const a=await fixture(t);const revoke=a.request(textMessage(),{operation:C.REVOKE,payload:{}});
  await a.execute(revoke,true);a.restart();await assert.rejects(a.execute(),{code:'asset_revoked'});
  await a.execute(a.request(textMessage(),{tenantRef:'clinic:72'}));assert.equal(a.sends().length,1);
});
test('Secret callbacks cannot return bearer values; all borrowed buffers are wiped',async t=>{
  const a=await fixture(t);let borrowed;
  await assert.rejects(a.secrets.withSecret(a.binding,token=>{borrowed=token;return {leak:token.toString('utf8')};}),{code:'provider_failed'});
  assert(borrowed.every(v=>v===0));assert.equal(a.sends().length,0);
});
test('A local revocation during the secret callback invalidates the borrowed proof',async t=>{
 const a=await fixture(t);
 await assert.rejects(a.secrets.withSecret(a.binding,token=>{a.blockScope();return a.secrets.proof(token,a.binding.connectionRef);}),{code:'asset_revoked'});
 assert.equal(a.sends().length,0);
});
test('Template digest includes static buttons and image format while ignoring provider examples',()=>{
  const v=template();const digest=C.templateDigest(v);v.components[0].example.header_handle=['CHANGED_EXAMPLE'];assert.equal(C.templateDigest(v),digest);
  v.components[2].buttons[0].text='Otra acción';assert.notEqual(C.templateDigest(v),digest);
});

test('A newly created template can send without a second local approval', async t => {
  const a = await fixture(t); const message = templateMessage(); message.template.name = 'not_authorized_v1';
  await a.execute(a.request(message));
  assert.equal(a.sends().length, 1);
  assert.equal(a.state.calls.filter(c => c.action === 'template').length, 0);
});

test('A large clinic catalog includes custom templates and still rejects duplicate identities', async t => {
  const a = await fixture(t);
  const definition = structuredClone(a.definition);
  definition.templates = Array.from({ length: 671 }, (_, i) => ({ ...a.definition.templates[0],
    id: String(10000 + i), name: 'catalog_version_' + i }));
  definition.templates.push({ ...a.definition.templates[0], id: '20000', name: 'cc_custom_clinic_greeting' });
  const accepted = validateAuthorization(definition);
  assert.equal(accepted.templates.length, 672);
  assert.equal(accepted.templates.at(-1).name, 'cc_custom_clinic_greeting');
  definition.templates.push({ ...definition.templates[0], id: '20001' });
  assert.throws(() => validateAuthorization(definition), { code: 'invalid_request' });
});

test('signed DEV calls cannot access another clinic and do not reuse public receipts', async t => {
  const a = await fixture(t), { generateKeyPairSync } = require('node:crypto'), { signRequest } = require('../src/auth');
  const key = generateKeyPairSync('ed25519');
  a.policy.principals.push({ id: 'dev:whatsapp', keyId: 'dev-whatsapp-v1', enabled: true, maxPerMinute: 30,
    publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  a.policy.grants.push({ ...a.policy.grants[0], principalId: 'dev:whatsapp' }); a.restart();
  const execute = request => { const signed = signRequest(request, { keyId: 'dev-whatsapp-v1', privateKey: key.privateKey,
    audience: a.policy.audience, now: a.f.now() }); return a.current.broker.execute(signed.raw, signed.headers); };
  const request = a.request();
  await a.execute(request); await execute(request); await execute(request);
  assert.equal(a.sends().length, 2); // Same UUID is scoped to its authenticated principal.
  const reads = a.f.state.awsCalls.length;
  await assert.rejects(execute(a.request(textMessage(), { tenantRef: 'clinic:72' })), { code: 'scope_denied' });
  await assert.rejects(execute(a.request(textMessage(), { operation: C.REVOKE, payload: {} })), { code: 'scope_denied' });
  assert.equal(a.f.state.awsCalls.length, reads); assert.equal(a.sends().length, 2);
  a.blockScope(); await assert.rejects(execute(a.request()), { code: 'asset_revoked' });
});
