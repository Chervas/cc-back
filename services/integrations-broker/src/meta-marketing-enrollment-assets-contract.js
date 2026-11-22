'use strict';
const {fail}=require('./errors'),C=require('./meta-marketing-oauth-contract'),D=require('./meta-marketing-discovery-contract');
const E=require('./meta-marketing-enrollment-contract'),R=require('./meta-marketing-credential-renewal-contract'),K=require('./meta-marketing-credential-shape');
const MAX_AGE_MS=300000,HASH=/^[a-f0-9]{64}$/;
const keys='enrollmentId,scopeKey,scopeDigest,selectionDigest,clinicSetDigest,assetSetDigest,epoch,versionId,digest,observedAt,expiresAt,availableKinds,assets';
const epoch=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const kinds=(metadata,selected)=>D.kinds(metadata).filter(kind=>selected.some(asset=>asset.kind===kind));
function identities(assets){return E.assets(assets.map(E.identity));}
function sameSelection(assets,selected){return JSON.stringify(identities(assets))===JSON.stringify(E.assets(selected));}
function selectedInventory(assets,selected,metadata,includeAvatars){
  const chosen=E.assets(selected);
  if(!Array.isArray(assets)||assets.length>D.MAX_ASSETS)fail('provider_failed');
  const results=chosen.map(asset=>{
    const matches=assets.filter(value=>value?.assetRef===asset.assetRef);
    if(matches.length!==1||JSON.stringify(E.identity(matches[0]))!==JSON.stringify(asset))fail('scope_denied');
    return matches[0];
  });
  D.checkAssets(results,metadata,{includeAvatars});return results;
}
function result({assets,selected,metadata,request,binding,row,credential,now}){
  E.validators.assets(request.payload);K.metadata(metadata,binding);
  const p=request.payload,b=K.bindingFor(binding),chosen=E.assets(selected),assetSetDigest=R.assetSetDigest(chosen);
  if(!epoch(credential?.epoch)||!C.uuid(credential.versionId)||!HASH.test(credential.digest))fail('secret_unavailable');
  if(p.expectedEpoch!==credential.epoch||p.expectedVersionId!==credential.versionId||p.expectedCandidateDigest!==credential.digest)fail('secret_version_changed');
  if(row?.id!==p.enrollmentId||row.scope_digest!==p.scopeDigest||row.selection_digest!==p.selectionDigest
    ||C.clinicDigest(b)!==p.clinicSetDigest||assetSetDigest!==p.assetSetDigest)fail('scope_denied');
  const value={enrollmentId:row.id,scopeKey:b.scopeKey,scopeDigest:row.scope_digest,selectionDigest:row.selection_digest,
    clinicSetDigest:C.clinicDigest(b),assetSetDigest,epoch:credential.epoch,versionId:credential.versionId,digest:credential.digest,
    observedAt:now,expiresAt:Math.min(now+MAX_AGE_MS,...[metadata.expiresAt,metadata.dataAccessExpiresAt].filter(value=>value!==null)),
    availableKinds:kinds(metadata,chosen),assets:selectedInventory(assets,chosen,metadata,p.includeAvatars===true)};
  if(value.expiresAt<=now||Buffer.byteLength(JSON.stringify(value))>D.MAX_RESULT_BYTES)fail('scope_denied');
  return value;
}
function validateResult(value,{enrollmentId,scopeKey,scopeDigest,selectionDigest,clinicSetDigest,assetSetDigest,epoch:expectedEpoch,versionId,digest,metadata,selected,startedAt,now,includeAvatars=false}){
  if(!C.exact(value,keys)||!C.uuid(value.enrollmentId)||value.enrollmentId!==enrollmentId||value.scopeKey!==scopeKey
    ||!epoch(value.epoch)||value.epoch!==expectedEpoch||!C.uuid(value.versionId)||value.versionId!==versionId||!HASH.test(value.digest)||value.digest!==digest
    ||!['scopeDigest','selectionDigest','clinicSetDigest','assetSetDigest'].every(key=>HASH.test(value[key]))
    ||value.scopeDigest!==scopeDigest||value.selectionDigest!==selectionDigest||value.clinicSetDigest!==clinicSetDigest||value.assetSetDigest!==assetSetDigest
    ||value.assetSetDigest!==R.assetSetDigest(selected)||!Number.isSafeInteger(value.observedAt)||value.observedAt<startedAt-5000||value.observedAt>now+5000
    ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>value.observedAt+MAX_AGE_MS
    ||[metadata.expiresAt,metadata.dataAccessExpiresAt].some(limit=>limit!==null&&value.expiresAt>limit)
    ||Buffer.byteLength(JSON.stringify(value))>D.MAX_RESULT_BYTES)fail('provider_failed');
  D.checkAssets(value.assets,metadata,{includeAvatars});
  if(!sameSelection(value.assets,selected)||JSON.stringify(value.availableKinds)!==JSON.stringify(kinds(metadata,selected)))fail('provider_failed');
  return structuredClone(value);
}
module.exports={MAX_AGE_MS,result,validateResult};
