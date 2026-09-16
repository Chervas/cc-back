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
  assert(a.state.calls.some(c=>c.action==='inspect'));assert(a.state.calls.some(c=>c.action==='waba_owner'));assert(a.state.calls.some(c=>c.action==='phones'));
});
test('Staged credential survives the completed OAuth window but not operational expiry',async t=>{
  const a=await fixture(t);a.f.state.clock+=660000;await a.execute();a.f.state.clock=a.definition.expiresAt;
  await assert.rejects(a.execute(),{code:'connection_blocked'});assert.equal(a.sends().length,1);
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
test('Another enrollment may expand a selection-only grant without expanding the sender',async t=>{
  const a=await fixture(t);a.state.after=(request,result)=>{
    if(request.action==='inspect')for(const grant of result.data.granular_scopes)grant.target_ids.push('399');
    return result;
  };
  await a.execute();assert.equal(a.sends().length,1);assert.equal(a.sends()[0].id,'401');
  assert.ok(a.state.calls.some(c=>c.action==='waba_owner'&&c.id==='399'));
  const request=a.request();request.assetRef='wa-phone:499';request.payload.phoneId='499';
  await assert.rejects(a.execute(request),{code:'scope_denied'});assert.equal(a.sends().length,1);
});
for(const mutation of ['lost_selected','foreign_new_owner'])test('Expanded grant still rejects '+mutation,async t=>{
  const a=await fixture(t);a.state.after=(request,result)=>{
    if(request.action==='inspect')for(const grant of result.data.granular_scopes){
      if(mutation==='lost_selected')grant.target_ids=['399'];else grant.target_ids.push('399');
    }
    if(mutation==='foreign_new_owner'&&request.action==='waba_owner'&&request.id==='399')result.owner_business_info.id='999';
    return result;
  };
  await assert.rejects(a.execute(),{code:'scope_denied'});assert.equal(a.sends().length,0);
});
for(const mutation of ['foreign_owner','subject','scope','phone','revoked'])test('Fresh Meta '+mutation+' proof prevents POST',async t=>{
  const a=await fixture(t);a.state.after=(request,result)=>{
    if(mutation==='foreign_owner'&&request.action==='waba_owner')result.owner_business_info.id='999';
    if(request.action==='inspect'){if(mutation==='subject')result.data.user_id='999';if(mutation==='scope')result.data.scopes.push('ads_management');if(mutation==='revoked')result.data.is_valid=false;}
    if(mutation==='phone'&&request.action==='phones')result.data=[{id:'999'}];return result;
  };await assert.rejects(a.execute());assert.equal(a.sends().length,0);
});
test('Image header, BODY values, QUICK_REPLY and dynamic URL buttons preserve their real Graph message',async t=>{
  const a=await fixture(t);const message=templateMessage();await a.execute(a.request(message));assert.deepEqual(a.sends()[0].json,message);
  assert.equal(a.state.calls.filter(c=>c.action==='template').length,1);
});
test('Changed button text or template status denies sending despite same template name',async t=>{
  const a=await fixture(t);a.state.remoteTemplate.components[2].buttons[0].text='FRAUDULENT';await assert.rejects(a.execute(a.request(templateMessage())),{code:'operation_denied'});assert.equal(a.sends().length,0);
});
test('Template parameters must match the pinned components including dynamic URL positions',async t=>{
  const a=await fixture(t);const message=templateMessage();message.template.components=message.template.components.filter(c=>c.type!=='button');
  await assert.rejects(a.execute(a.request(message)),{code:'operation_denied'});assert.equal(a.sends().length,0);
});
test('A block during template lookup is rechecked immediately before POST',async t=>{
  const a=await fixture(t);a.state.after=(request,result)=>{if(request.action==='template')a.blockScope();return result;};
  await assert.rejects(a.execute(a.request(templateMessage())),{code:'asset_revoked'});assert.equal(a.sends().length,0);
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
test('A scope block during grant ownership verification stops before another Meta operation',async t=>{
  const a=await fixture(t);a.state.after=(r,v)=>{if(r.action==='waba_owner')a.blockScope();return v;};
  await assert.rejects(a.execute(),{code:'asset_revoked'});assert.equal(a.state.calls.some(c=>c.action==='phones'),false);assert.equal(a.sends().length,0);
});
test('Secret callbacks cannot return bearer values; all borrowed buffers are wiped',async t=>{
  const a=await fixture(t);let borrowed;
  await assert.rejects(a.secrets.withSecret(a.binding,token=>{borrowed=token;return {leak:token.toString('utf8')};}),{code:'provider_failed'});
  assert(borrowed.every(v=>v===0));assert.equal(a.sends().length,0);
});
test('Provider expiry during template lookup rejects the send after fresh inspection',async t=>{
  const a=await fixture(t);const at=a.f.now();a.state.after=(r,v)=>{
    if(r.action==='inspect')v.data.expires_at=Math.ceil(at/1000)+1;
    if(r.action==='template')a.f.state.clock=at+3000;return v;
  };
  await assert.rejects(a.execute(a.request(templateMessage())),{code:'credential_revoked'});assert.equal(a.sends().length,0);
});
test('Template digest includes static buttons and image format while ignoring provider examples',()=>{
  const v=template();const digest=C.templateDigest(v);v.components[0].example.header_handle=['CHANGED_EXAMPLE'];assert.equal(C.templateDigest(v),digest);
  v.components[2].buttons[0].text='Otra acción';assert.notEqual(C.templateDigest(v),digest);
});

test('An unpinned template is explicitly rejected before any template read or send', async t => {
  const a = await fixture(t); const message = templateMessage(); message.template.name = 'not_authorized_v1';
  await assert.rejects(a.execute(a.request(message)), { code: 'whatsapp_template_not_authorized' });
  assert.equal(a.sends().length, 0);
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
