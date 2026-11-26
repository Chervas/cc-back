'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {admissionFixture}=require('./meta-marketing-admission-fixture.cjs');
const {createInstagramSlots}=require('../src/meta-marketing-instagram-slots');
const {ACCOUNT}=require('../src/google-main');

test('new pages get distinct candidate slots, existing slots survive restart, reads and rejected attempts do not allocate',async t=>{
  const f=admissionFixture(t), binding=f.f.policy.connections[0];
  const init=()=>createInstagramSlots({store:f.current.store,client:f.aws,environment:'staging',account:ACCOUNT,limit:2});
  const resolve=init(),authorize=()=>{};
  let audits=0;
  const audit=()=>{audits++;};
  assert.equal(await resolve(binding,'14001',null),null);
  await assert.rejects(resolve(binding,'14001',()=>{throw Error('invalid mapping');}),/invalid mapping/);
  assert.equal(f.state.creates,0);
  f.state.loseCreate=true;
  const one=await resolve(binding,'14001',authorize,audit);
  const two=await resolve(binding,'14002',authorize,audit);
  assert.notEqual(one.secretArn,two.secretArn);
  assert.notEqual(one.secretArn,binding.secretArn);
  assert.deepEqual(await init()(binding,'14001',null),one);
  assert.equal(f.state.creates,2);
  await assert.rejects(resolve(binding,'14003',authorize,audit),{code:'rate_limited'});
  await assert.rejects(resolve({...binding,connectionRef:'different-connection'},'14001',null),{code:'scope_denied'});
  assert.equal(f.state.creates,2);
  assert.equal(audits,2);
});
