'use strict';
const F=require('../src/lib/metaMarketingBusinessSchema'),E=require('../src/lib/mysqlEnumExtension');
module.exports={async up(q,S){
  for(const [table,fields,indexes]of[
    [F.TABLES[0],F.handoverFields,[['cc_meta_business_new',['new_enrollment_id'],true],['cc_meta_business_pending',['pending_scope_key'],true],['cc_meta_business_state_hash',['state_hash'],true],['cc_meta_business_code',['code_digest'],true],['cc_meta_business_latest',['scope_key','requested_at','handover_id']],['cc_meta_business_due',['state','next_attempt_at','lease_until']]]],
    [F.TABLES[1],F.maintenanceFields,[['cc_meta_maintenance_pending',['pending_enrollment_id'],true],['cc_meta_maintenance_latest',['enrollment_id','requested_at','maintenance_id']],['cc_meta_maintenance_due',['state','next_attempt_at','lease_until']]]],
    [F.TABLES[2],F.drainFields,[['cc_meta_business_drain_active',['active_enrollment_id'],true],['cc_meta_business_drain_enrollment',['enrollment_id']],['cc_meta_business_drain_scope',['scope_key','state']]]]
  ]){await q.createTable(table,fields(S),{charset:'ascii',collate:'ascii_bin'});for(const [name,columns,unique=false]of indexes)await q.addIndex(table,columns,{name,unique});}
  const read=async()=>{const rows=await q.sequelize.query(E.metadataSql,{replacements:['MetaMarketingEnrollmentRequests','state'],type:S.QueryTypes.SELECT});if(rows.length!==1)throw Error('meta_business_enrollment_state_missing');return E.column(rows[0]);};
  const before=await read(),members=['prepare_pending','prepared','activate_pending','active','revoke_pending','revoked'];
  if(JSON.stringify(before.values)!==JSON.stringify(members)&&JSON.stringify(before.values)!==JSON.stringify([...members,'superseded']))throw Error('meta_business_enrollment_state_changed');
  if(!before.values.includes('superseded')){const after={...before,values:[...members,'superseded']};E.validate(before,after);await q.sequelize.query(E.sql('MetaMarketingEnrollmentRequests','state',after));E.validate(after,await read(),false);}
},async down(){throw Error('meta_business_continuity_history_must_be_preserved');}};
