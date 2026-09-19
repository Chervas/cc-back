'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {fixture}=require('../../../services/integrations-broker/test/meta-marketing-oauth-fixture.cjs');
const E=require('../../../services/integrations-broker/src/meta-marketing-enrollment-contract'),M=require('../../../services/integrations-broker/src/meta-marketing-contract');
test('maximum selected set with a populated physical revocation index remains bounded and closes on a late recorded revocation',async t=>{
  const f=fixture(t,{enrollment:true}),ids=Array.from({length:100},(_,i)=>String(301+i));
  f.state.afterGraph=(kind,value)=>{
    if(kind==='inspect')value.data.granular_scopes[0].target_ids=ids;
    if(kind==='adaccounts')value.data=ids.map(id=>({id:'act_'+id,account_id:id,name:'Cuenta ficticia '+id,account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'}));
    if(kind==='accounts')value.data=[];return value;
  };
  const flow=await f.begin(),candidate=(await f.finish(flow)).data.candidate,db=f.current.store.db;
  f.current.store.transaction(()=>{
    const insert=db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)');
    for(let i=0;i<10000;i++)insert.run('clinic:99','connection:fictitious-history','meta-ad_account:'+String(10001+i),randomUUID(),f.now());
  });
  const countBefore=f.state.awsCalls.length,graphBefore=f.state.httpCalls.length,enrollmentId=randomUUID(),started=performance.now();
  const prepared=(await f.execute(E.OPERATIONS.prepare,{enrollmentId,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:candidate.digest,assetRefs:ids.map(id=>'meta-ad_account:'+id)})).data;
  const preparedAt=performance.now();assert.equal(prepared.assets.length,100);assert.equal(prepared.accessBlocked,true);
  const activated=(await f.execute(E.OPERATIONS.activate,{enrollmentId,scopeDigest:flow.payload.scopeDigest,selectionDigest:prepared.selectionDigest})).data;
  const activatedAt=performance.now();assert.equal(activated.assets.length,100);assert.equal(activated.accessBlocked,false);
  const read=()=>f.execute(M.ASSET,{}, {assetRef:'meta-ad_account:301'},'reader');
  assert.equal((await read()).data.id,'act_301');const readAt=performance.now();
  assert.equal(f.state.awsCalls.length-countBefore,48);assert.equal(f.state.httpCalls.length-graphBefore,11);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_claims').get().n,100);
  db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:99','connection:other-origin','meta-ad_account:350',randomUUID(),f.now());
  const before=f.state.awsCalls.length;await assert.rejects(read(),{code:'asset_revoked'});assert.equal(f.state.awsCalls.length,before);
  t.diagnostic(JSON.stringify({selected:100,preexistingRevocations:10000,prepareMs:Math.round(preparedAt-started),activateMs:Math.round(activatedAt-preparedAt),readMs:Math.round(readAt-activatedAt),secretCalls:48,graphCalls:11,realProvider:false}));
});
