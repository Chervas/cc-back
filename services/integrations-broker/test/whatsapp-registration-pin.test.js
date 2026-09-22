'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {fixture}=require('./whatsapp-onboarding-fixture.cjs');const {createRegistrationPins}=require('../src/whatsapp-registration-pin');
const {SECRET_KEY}=require('../src/google-main');
test('registration PIN survives lost vault acknowledgement, never replaces candidate/current, and rejects changed phone',async t=>{
  const f=fixture(t,{customer:{selectionOnly:true}});const flow=await f.begin();await f.finish(flow);let writes=0,lost=true;
  const client={send:async command=>{
    const input=command.input,versions=f.records.get(input.SecretId);
    if(command.constructor.name==='GetSecretValueCommand'&&!versions.has(input.VersionId))throw Object.assign(Error('MISSING'),{name:'ResourceNotFoundException'});
    if(command.constructor.name!=='PutSecretValueCommand')return f.aws.send(command);
    writes++;assert.deepEqual(input.VersionStages,['CC_REGISTRATION_PIN']);
    versions.set(input.ClientRequestToken,{body:input.SecretString,stages:[...input.VersionStages]});
    if(lost){lost=false;throw Error('LOST_ACK')}return {ARN:input.SecretId,VersionId:input.ClientRequestToken};
  }};
  const pin=createRegistrationPins({client,kmsKeyArn:SECRET_KEY}),options={binding:f.binding,flowId:flow.flowId,phoneId:'401',versionId:randomUUID(),signal:AbortSignal.timeout(10000)};
  await assert.rejects(pin(options,()=>assert.fail('not called')),/LOST_ACK/);
  let observed;await pin(options,value=>{assert.match(value,/^\d{6}$/);observed=value;});
  await pin(options,value=>assert.equal(value,observed));assert.equal(writes,1);
  await assert.rejects(pin({...options,phoneId:'402'},()=>assert.fail('not called')),/secret_unavailable/);
  const versions=f.records.get(f.binding.secretArn);assert.deepEqual(versions.get(flow.flowId).stages,['AWSPENDING']);
  assert.deepEqual(versions.get(f.binding.whatsappOnboarding.slotVersionId).stages,['AWSCURRENT']);
});
