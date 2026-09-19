'use strict';
const {createHash}=require('node:crypto'),M=require('../../services/integrations-broker/src/meta-marketing-contract');
const R=require('./metaMarketingRevocation.contract');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,STATE=/^[A-Za-z0-9_-]{43}$/;
const fail=(code='meta_oauth_unavailable',httpStatus=503)=>{throw Object.assign(Error(code),{code,httpStatus});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const frontendOrigin=(env=process.env)=>env.FRONTEND_URL?new URL(env.FRONTEND_URL).origin:'https://crm.clinicaclick.com';
function slot(row){
  if(!row)fail();let ids,scopes;
  try{ids=R.storedIds(row.clinic_ids);scopes=JSON.parse(row.scopes);R.scopeKey(row.scope_key);}catch{fail();}
  let uri;try{uri=new URL(row.redirect_uri);}catch{fail();}
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.connection_ref)||row.asset_ref!=='meta-enroll:'+row.scope_key
    ||!M.graphId(row.app_id)||!['active','blocked'].includes(row.state)||!(row.expires_at instanceof Date)||!Number.isFinite(+row.expires_at)
    ||!Array.isArray(scopes)||JSON.stringify([...new Set(scopes)].sort())!==row.scopes||!scopes.includes('public_profile')||scopes.length<2||scopes.some(s=>!M.SCOPES.includes(s))
    ||uri.href!==row.redirect_uri||uri.protocol!=='https:'||uri.username||uri.password||uri.port||uri.search||uri.hash||uri.pathname!=='/oauth/meta/marketing/callback'
    ||row.scope_key.startsWith('clinic:')&&(ids.length!==1||row.scope_key!=='clinic:'+ids[0]))fail();
  return {...row,clinicIds:ids,scopeValues:scopes};
}
const slotDigest=row=>{const s=slot(row);return hash(JSON.stringify([s.scope_key,s.connection_ref,s.asset_ref,s.app_id,s.clinic_ids,s.scopes,s.redirect_uri,s.expires_at.toISOString(),s.state]));};
function candidate(value,row){
  const keys='versionId,digest,appId,subjectId,tokenType,scopes,expiresAt,dataAccessExpiresAt,granularScopes';
  if(!exact(value,keys)||value.versionId!==row.flow_id||!/^[a-f0-9]{64}$/.test(value.digest)||value.appId!==row.app_id||!M.graphId(value.subjectId)
    ||value.tokenType!=='USER'||JSON.stringify(value.scopes)!==row.scopes||![value.expiresAt,value.dataAccessExpiresAt].every(v=>v===null||Number.isSafeInteger(v)&&v>0)
    ||!Array.isArray(value.granularScopes)||value.granularScopes.length>value.scopes.length
    ||value.granularScopes.some((v,i,all)=>!exact(v,'scope,targetIds')||!value.scopes.includes(v.scope)||i>0&&v.scope<=all[i-1].scope
      ||!Array.isArray(v.targetIds)||v.targetIds.length>1000||v.targetIds.some((id,j,ids)=>!M.graphId(id)||j>0&&id<=ids[j-1])))fail('broker_response_invalid');
  return structuredClone(value);
}
const OPEN=['begin_pending','awaiting','processing','staged','cancel_pending','interrupted'];
module.exports={UUID,STATE,fail,hash,exact,positive,slot,slotDigest,candidate,OPEN,frontendOrigin};
