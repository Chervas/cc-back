'use strict';
const {fail}=require('./errors'),C=require('./meta-marketing-oauth-contract'),K=require('./meta-marketing-credential-shape');
const COHORT='meta-marketing-enrolled-asset-access-v1';
const REQUIRED_SCOPES=Object.freeze(['ads_management','ads_read','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list','public_profile']);
function config(value){
  if(!C.exact(value,'enabled,cohort,scopeKeys')||value.enabled!==true||value.cohort!==COHORT
    ||!Array.isArray(value.scopeKeys)||!value.scopeKeys.length||value.scopeKeys.length>64||new Set(value.scopeKeys).size!==value.scopeKeys.length
    ||value.scopeKeys.some(key=>typeof key!=='string'||!/^clinic:[1-9][0-9]{0,9}$/.test(key)||Number(key.slice(7))>2147483647))fail('invalid_request');
  return value;
}
function includes(value,binding){return !!value&&config(value).scopeKeys.includes(K.bindingFor(binding).scopeKey);}
function authorize(value,binding,metadata){
  if(!includes(value,binding)||K.business(binding))fail('scope_denied');
  const b=C.bindingFor(binding);
  if(b.clinicIds.length!==1||b.scopeKey!=='clinic:'+b.clinicIds[0]||metadata.tokenType!=='USER'
    ||!REQUIRED_SCOPES.every(scope=>b.scopes.includes(scope)&&metadata.scopes.includes(scope)))fail('scope_denied');
  C.metadata(metadata,binding);
}
module.exports={COHORT,REQUIRED_SCOPES,config,includes,authorize};
