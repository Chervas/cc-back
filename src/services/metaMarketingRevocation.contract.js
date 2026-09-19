'use strict';
const {createHash}=require('node:crypto');
const {positive,reference,asset}=require('./metaMarketingBrokerScope.service');
const {graphId,REVOKE}=require('../../services/integrations-broker/src/meta-marketing-contract');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw Object.assign(Error('meta_revocation_unavailable'),{code:'meta_revocation_unavailable',httpStatus:503});};
const IDENTITY=['tuple_hash','asset_ref','connection_ref','meta_connection_id','meta_user_id','app_id','parent_page_id','tenant_clinic_id'];
const FIELDS=[...IDENTITY,'scope_key','clinic_ids','mapping_ids','request_id','actor_user_id'];
const tupleHash=row=>createHash('sha256').update(JSON.stringify([Number(row.tenant_clinic_id),row.connection_ref,row.asset_ref])).digest('hex');
function ids(values,empty=false){
  if(!Array.isArray(values)||values.length>1000||!empty&&!values.length||values.some(v=>!positive(v)))fail();
  return [...new Set(values.map(Number))].sort((a,b)=>a-b);
}
function storedIds(value){
  if(typeof value!=='string'||value.length>12000)fail();let result;
  try{result=ids(JSON.parse(value));}catch{fail();}if(JSON.stringify(result)!==value)fail();return result;
}
function scopeKey(value){if(typeof value!=='string'||!/^(clinic|group):[1-9]\d{0,9}$/.test(value)||!positive(value.split(':')[1]))fail();return value;}
function identity(row){
  const resource=asset(row.asset_ref);
  if(!reference(row.connection_ref)||!positive(row.meta_connection_id)||!positive(row.tenant_clinic_id)
    ||!graphId(row.meta_user_id)||!graphId(row.app_id)||row.tuple_hash!==tupleHash(row)
    ||(resource.kind==='instagram_business'?!graphId(row.parent_page_id):row.parent_page_id!==null))fail();
  return Object.fromEntries(IDENTITY.map(k=>[k,['meta_connection_id','tenant_clinic_id'].includes(k)?Number(row[k]):row[k]]));
}
function validate(row){
  identity(row);scopeKey(row.scope_key);storedIds(row.mapping_ids);
  if(!storedIds(row.clinic_ids).includes(Number(row.tenant_clinic_id))||!UUID.test(row.request_id)||!positive(row.actor_user_id)
    ||!['pending','confirmed'].includes(row.state)||!Number.isFinite(new Date(row.requested_at).getTime()))fail();return row;
}
module.exports={identity,validate,tupleHash,ids,storedIds,scopeKey,IDENTITY,FIELDS,UUID,fail,REVOKE};
