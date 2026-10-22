'use strict';
module.exports=(sequelize,D)=>sequelize.define('PatientImportedIdentity',{
  id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},catalog_id:{type:D.BIGINT.UNSIGNED,allowNull:false},patient_id:{type:D.INTEGER,allowNull:false},clinic_id:{type:D.INTEGER,allowNull:false},
  source_system:{type:D.STRING(32),allowNull:false},source_instance:{type:D.STRING(100),allowNull:false},source_patient_id:{type:D.STRING(80),allowNull:false},
  source_history_number:D.STRING(100),bundle_sha256:{type:D.CHAR(64),allowNull:false},messages_hold:{type:D.BOOLEAN,allowNull:false,defaultValue:true},
  imported_at:{type:D.DATE,allowNull:false},actor_user_id:{type:D.INTEGER,allowNull:false},
},{tableName:'PatientImportedIdentities',timestamps:false});
