'use strict';
const {fail}=require('./errors'),C=require('./meta-marketing-oauth-contract');
const COHORT='meta-marketing-lead-recovery-v1';
function config(value){
  // This incident's read/import capability is explicitly restricted to BS.
  // Other customers require a reviewed expansion rather than inheriting it.
  if(!C.exact(value,'enabled,cohort,scopeKeys')||value.enabled!==true||value.cohort!==COHORT
    ||!Array.isArray(value.scopeKeys)||value.scopeKeys.length!==1||value.scopeKeys[0]!=='group:29')fail('invalid_request');
  return value;
}
module.exports={COHORT,config};
