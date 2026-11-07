'use strict';
const {maintenanceFields}=require('../src/lib/metaMarketingBusinessSchema');
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingCredentialMaintenance',maintenanceFields(D),{tableName:'MetaMarketingCredentialMaintenances',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[
  {name:'cc_meta_maintenance_pending',unique:true,fields:['pending_enrollment_id']},{name:'cc_meta_maintenance_latest',fields:['enrollment_id','requested_at','maintenance_id']},
  {name:'cc_meta_maintenance_due',fields:['state','next_attempt_at','lease_until']}]});
