'use strict';
// Explicit server cohort only; a health grant does not grant token renewal.
function scopeKeys(env=process.env){
 const raw=env.META_MARKETING_USER_HEALTH_SCOPE_KEYS;
 if(raw===undefined||raw==='')return [];
 let values;try{values=JSON.parse(raw);}catch{throw Object.assign(Error('broker_configuration_invalid'),{code:'broker_configuration_invalid'});}
 if(!Array.isArray(values)||values.length>64||new Set(values).size!==values.length
  ||values.some(value=>typeof value!=='string'||!/^(clinic|group):[1-9][0-9]{0,9}$/.test(value)))
  throw Object.assign(Error('broker_configuration_invalid'),{code:'broker_configuration_invalid'});
 return values.slice();
}
// Only called after the owner observation and current epoch/version/digest are
// verified. Health may shorten a deadline; only a new credential can extend it.
function boundedObservation(observed,current){
 const bound=key=>{const values=[current[key],observed[key]].filter(value=>value!==null);return values.length?Math.min(...values):null;};
 const expiresAt=bound('expiresAt'),dataAccessExpiresAt=bound('dataAccessExpiresAt');
 const expired=[expiresAt,dataAccessExpiresAt].some(value=>value!==null&&value<=observed.verifiedAt);
 return{...observed,expiresAt,dataAccessExpiresAt,healthy:observed.healthy&&!expired,
  reason:observed.healthy&&expired?'credential_expired':observed.reason};
}
module.exports={scopeKeys,boundedObservation};
