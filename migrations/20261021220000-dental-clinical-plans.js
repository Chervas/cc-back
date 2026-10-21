'use strict';
module.exports={
 async up(q,S){
  const ref=(model,key,type)=>({type,allowNull:false,references:{model,key},onDelete:'RESTRICT',onUpdate:'RESTRICT'});
  await q.createTable('DentalPlans',{
   id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},public_id:{type:S.STRING(36),allowNull:false,unique:true},
   clinic_id:ref('Clinicas','id_clinica',S.INTEGER),patient_id:ref('Pacientes','id_paciente',S.INTEGER),
   budget_id:{...ref('EconomicBudgets','id',S.BIGINT.UNSIGNED),allowNull:true},
   version_number:{type:S.INTEGER.UNSIGNED,allowNull:false},status:{type:S.STRING(20),allowNull:false},state:{type:S.JSON,allowNull:false},
   creation_key:{type:S.STRING(64),allowNull:false,unique:true},creation_hash:{type:S.STRING(64),allowNull:false},
   created_by:{type:S.INTEGER,allowNull:false},updated_by:{type:S.INTEGER,allowNull:false},created_at:{type:S.DATE,allowNull:false},updated_at:{type:S.DATE,allowNull:false},
  });
  await q.addIndex('DentalPlans',['clinic_id','patient_id','updated_at'],{name:'dental_plan_patient_date'});
  await q.createTable('DentalPlanRevisions',{
   id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},plan_id:ref('DentalPlans','id',S.BIGINT.UNSIGNED),
   version_number:{type:S.INTEGER.UNSIGNED,allowNull:false},snapshot:{type:S.JSON,allowNull:false},sha256:{type:S.STRING(64),allowNull:false},command:{type:S.STRING(40),allowNull:false},
   mutation_key:{type:S.STRING(64),allowNull:false},request_hash:{type:S.STRING(64),allowNull:false},actor_id:{type:S.INTEGER,allowNull:false},created_at:{type:S.DATE,allowNull:false},
  });
  await q.addIndex('DentalPlanRevisions',['plan_id','version_number'],{name:'dental_plan_revision_once',unique:true});
  await q.addIndex('DentalPlanRevisions',['plan_id','mutation_key'],{name:'dental_plan_command_once',unique:true});
 },
 async down(){throw Error('dental_clinical_history_preserved: retain plans, revisions and execution references; roll back compatible code only.');},
};
