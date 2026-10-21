'use strict';
module.exports=(sequelize,D)=>sequelize.define('DentalSupportingTools',{
  id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},public_id:{type:D.STRING(36),allowNull:false,unique:true},
  plan_id:{type:D.BIGINT.UNSIGNED,allowNull:false,unique:true},clinic_id:{type:D.INTEGER,allowNull:false},patient_id:{type:D.INTEGER,allowNull:false},
  version_number:{type:D.INTEGER.UNSIGNED,allowNull:false},state:{type:D.JSON,allowNull:false},
  created_by:{type:D.INTEGER,allowNull:false},updated_by:{type:D.INTEGER,allowNull:false},
},{tableName:'DentalSupportingTools',underscored:true,createdAt:'created_at',updatedAt:'updated_at'});
