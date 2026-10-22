'use strict';
module.exports=(sequelize,D)=>sequelize.define('PatientImportedSourceRecord',{
  id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},identity_id:{type:D.BIGINT.UNSIGNED,allowNull:false},
  patient_id:{type:D.INTEGER,allowNull:false},clinic_id:{type:D.INTEGER,allowNull:false},source_key:{type:D.CHAR(64),allowNull:false},
  source_database:{type:D.STRING(120),allowNull:false},source_table:{type:D.STRING(80),allowNull:false},category:{type:D.STRING(32),allowNull:false},
  record_date:D.DATEONLY,row_sha256:{type:D.CHAR(64),allowNull:false},database_sha256:{type:D.CHAR(64),allowNull:false},bundle_sha256:{type:D.CHAR(64),allowNull:false},
  record_json:{type:D.TEXT('medium'),allowNull:false},imported_at:{type:D.DATE,allowNull:false},
},{tableName:'PatientImportedSourceRecords',timestamps:false});
