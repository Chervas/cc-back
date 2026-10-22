'use strict';
module.exports=(sequelize,D)=>sequelize.define('ImportedClinicalCatalog',{
  id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},clinic_id:{type:D.INTEGER,allowNull:false},
  source_system:{type:D.STRING(32),allowNull:false},source_instance:{type:D.STRING(100),allowNull:false},
  bundle_sha256:{type:D.CHAR(64),allowNull:false},source_zip_sha256:{type:D.CHAR(64),allowNull:false},catalog_sha256:{type:D.CHAR(64),allowNull:false},
  context_json:{type:D.TEXT('medium'),allowNull:false},imported_at:{type:D.DATE,allowNull:false},actor_user_id:{type:D.INTEGER,allowNull:false},
},{tableName:'ImportedClinicalCatalogs',timestamps:false});
