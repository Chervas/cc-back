'use strict';
// Offline only: the fixture owns its signed Broker policy and temporary SQLite.
// Real issuer contracts create bindings; no plain JSON issuer marker is used.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),K=require('../src/meta-marketing-credential-shape');
const B=require('../src/meta-marketing-business-contract'),AG=require('../src/meta-marketing-agency-contract');
const A=require('../src/meta-marketing-ads-contract'),X=require('../src/meta-marketing-enrolled-asset-access-contract');
const runtime=require('../src/meta-marketing-oauth-main');
const assets=[{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null},
  {assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null}];
const access=()=>({enabled:true,cohort:X.COHORT,scopeKeys:['clinic:95']});
function directFixture(t,agency){
  const f=fixture(t,{[agency?'agency':'business']:true,adsManagement:true}),scopeKey='clinic:95';
  f.binding.metaMarketingOAuth.scopeKey=scopeKey;f.binding.metaMarketingOAuth.clinicIds=[95];
  f.businessConfig.scopeKeys=[scopeKey];
  for(const grant of f.policy.grants)Object.assign(grant,{tenantRef:'clinic:95',assetRef:'meta-enroll:'+scopeKey});
  f.config.adsRead={enabled:true,cohort:A.COHORT,assetRefs:['meta-ad_account:301']};
  f.config.leadAds.pairs[0].recipientClinicId=95;
  return f;
}
for(const agency of [false,true]){
  const name=agency?'Agency system user':'Business system user';
  test(name+' owner binding cannot borrow enrolled USER asset access',t=>{
    const f=directFixture(t,agency),issuer=agency?AG:B,binding=issuer.derive(f.binding,f.businessConfig,assets);
    assert.equal(K.business(binding),true);assert.equal(K.bindingFor(binding).scopeKey,'clinic:95');
    const value={appId:'101',subjectId:'601',tokenType:'SYSTEM_USER',configId:f.businessConfig.configId,
      graphVersion:f.businessConfig.graphVersion,scopes:[...issuer.SCOPES],expiresAt:f.now()+3600000,dataAccessExpiresAt:null,granularScopes:[],
      ...(agency?{issuerKind:AG.ISSUER,issuerBusinessId:f.businessConfig.issuerBusinessId,systemUserId:'601'}:{clientBusinessId:'701'})};
    const metadata=issuer.metadata(value,binding);assert.equal(metadata.tokenType,'SYSTEM_USER');
    assert.throws(()=>X.authorize(access(),binding,metadata),{code:'scope_denied'});
    // Even valid USER metadata cannot turn an owner-created issuer binding
    // back into ordinary USER authority.
    const user=C.metadata({appId:'101',subjectId:'201',tokenType:'USER',scopes:[...f.binding.metaMarketingOAuth.scopes].sort(),
      expiresAt:f.now()+3600000,dataAccessExpiresAt:null,granularScopes:[]},f.binding);
    assert.throws(()=>X.authorize(access(),binding,user),{code:'scope_denied'});
  });
  test(name+' runtime configuration remains valid alone and rejects overlapping USER access cohort',t=>{
    const f=directFixture(t,agency),before=structuredClone(f.config);
    // Fixture supplies the complete Business/maintenance grants; acceptance
    // here proves the rejection below is caused by adding only this overlap.
    assert.equal(runtime.validateConfig(before),before);
    const overlapping=structuredClone(before);overlapping.enrolledAssetAccess=access();
    assert.throws(()=>runtime.validateConfig(overlapping),{code:'invalid_request'});
    delete overlapping.enrolledAssetAccess;assert.equal(runtime.validateConfig(overlapping),overlapping);
    assert.deepEqual(f.config,before);
  });
}
