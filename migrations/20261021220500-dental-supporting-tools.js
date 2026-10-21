'use strict';
module.exports={
  async up(q,S){
    const tables=(await q.showAllTables()).map(t=>typeof t==='string'?t:t.tableName||t.table_name);
    if(!tables.includes('DentalSupportingTools'))await q.createTable('DentalSupportingTools',{
      id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},public_id:{type:S.STRING(36),allowNull:false,unique:true},
      plan_id:{type:S.BIGINT.UNSIGNED,allowNull:false,references:{model:'DentalPlans',key:'id'},onDelete:'RESTRICT'},
      clinic_id:{type:S.INTEGER,allowNull:false,references:{model:'Clinicas',key:'id_clinica'},onDelete:'RESTRICT'},
      patient_id:{type:S.INTEGER,allowNull:false,references:{model:'Pacientes',key:'id_paciente'},onDelete:'RESTRICT'},
      version_number:{type:S.INTEGER.UNSIGNED,allowNull:false},state:{type:S.JSON,allowNull:false},created_by:{type:S.INTEGER,allowNull:false},updated_by:{type:S.INTEGER,allowNull:false},
      created_at:{type:S.DATE,allowNull:false},updated_at:{type:S.DATE,allowNull:false},
    });
    const index=async(table,fields,name)=>{if(!(await q.showIndex(table)).some(i=>i.name===name))await q.addIndex(table,fields,{name,unique:true});};
    await index('DentalSupportingTools',['plan_id'],'dental_tools_plan_once');
    if(!tables.includes('DentalSupportingToolsRevisions'))await q.createTable('DentalSupportingToolsRevisions',{
      id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},tool_id:{type:S.BIGINT.UNSIGNED,allowNull:false,references:{model:'DentalSupportingTools',key:'id'},onDelete:'RESTRICT'},
      version_number:{type:S.INTEGER.UNSIGNED,allowNull:false},snapshot:{type:S.JSON,allowNull:false},command_key:{type:S.STRING(120),allowNull:false},
      command_hash:{type:S.STRING(64),allowNull:false},command_type:{type:S.STRING(40),allowNull:false},actor_id:{type:S.INTEGER,allowNull:false},created_at:{type:S.DATE,allowNull:false},
    });
    await index('DentalSupportingToolsRevisions',['tool_id','version_number'],'dental_tools_revision_once');
    await index('DentalSupportingToolsRevisions',['tool_id','command_key'],'dental_tools_command_once');
  },
  async down(){throw Error('dental_tools_history_preserved: roll back compatible code, never drop clinical revisions');},
};
