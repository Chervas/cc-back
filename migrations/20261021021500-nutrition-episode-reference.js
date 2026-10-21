'use strict';
module.exports={
 async up(queryInterface,Sequelize){
  const columns=await queryInterface.describeTable('PatientNutritionMeasurements');
  if(!columns.episode_id)await queryInterface.addColumn('PatientNutritionMeasurements','episode_id',{type:Sequelize.STRING(36),allowNull:true,references:{model:'AppointmentClinicalReports',key:'public_id'},onDelete:'RESTRICT',onUpdate:'RESTRICT'});
  if(!(await queryInterface.showIndex('PatientNutritionMeasurements')).some(index=>index.name==='nutrition_measurement_episode'))await queryInterface.addIndex('PatientNutritionMeasurements',['clinic_id','patient_id','episode_id','measured_at'],{name:'nutrition_measurement_episode'});
 },
 async down(){throw new Error('Clinical measurement provenance must be preserved; roll back compatible code, not stored episode references.');}
};
