'use strict';
module.exports={
 async up(q,S){
  const columns=await q.describeTable('AppointmentClinicalReports');
  if(columns.form_data){if(String(columns.form_data.type).toUpperCase()!=='JSON'||columns.form_data.allowNull!==true||columns.form_data.defaultValue!=null)throw Error('clinical_form_schema_incompatible');return;}
  await q.addColumn('AppointmentClinicalReports','form_data',{type:S.JSON,allowNull:true});
 },
 async down(){throw Error('clinical_form_history_preserved: retain answers and snapshots; roll back compatible code only.');},
};
