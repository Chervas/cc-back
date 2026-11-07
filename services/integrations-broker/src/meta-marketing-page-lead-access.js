'use strict';
const M=require('./meta-marketing-contract'),{fail}=require('./errors');
const BOOLS=['app_has_leads_permission','can_access_lead','enabled_lead_access_manager','is_page_admin','user_has_leads_permission'];
const KEYS=new Set([...BOOLS,'page_id','user_id','failure_reason','failure_resolution']);
// Meta's HasLeadAccess is a structured object, not a boolean. Provider reason
// text is validated and discarded; it never becomes a log, API error or DTO.
function hasLeadAccess(value,pageId){
 if(!M.graphId(pageId)||!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!KEYS.has(k))
  ||typeof value.can_access_lead!=='boolean'||BOOLS.some(k=>Object.hasOwn(value,k)&&typeof value[k]!=='boolean')
  ||['page_id','user_id'].some(k=>Object.hasOwn(value,k)&&!M.graphId(value[k]))||Object.hasOwn(value,'page_id')&&value.page_id!==pageId
  ||['failure_reason','failure_resolution'].some(k=>Object.hasOwn(value,k)&&(typeof value[k]!=='string'||value[k].length>2048)))fail('provider_failed');
 return value.can_access_lead===true&&(!Object.hasOwn(value,'app_has_leads_permission')||value.app_has_leads_permission===true)
  &&(!Object.hasOwn(value,'user_has_leads_permission')||value.user_has_leads_permission===true);
}
module.exports={hasLeadAccess};
