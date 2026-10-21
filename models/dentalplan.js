'use strict';
module.exports=(sequelize,D)=>sequelize.define('DentalPlan',{
 id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},public_id:{type:D.STRING(36),allowNull:false,unique:true},
 clinic_id:{type:D.INTEGER,allowNull:false},patient_id:{type:D.INTEGER,allowNull:false},budget_id:{type:D.BIGINT.UNSIGNED,allowNull:true},
 version_number:{type:D.INTEGER.UNSIGNED,allowNull:false},status:{type:D.STRING(20),allowNull:false},state:{type:D.JSON,allowNull:false},
 creation_key:{type:D.STRING(64),allowNull:false,unique:true},creation_hash:{type:D.STRING(64),allowNull:false},
 created_by:{type:D.INTEGER,allowNull:false},updated_by:{type:D.INTEGER,allowNull:false},
},{tableName:'DentalPlans',underscored:true,createdAt:'created_at',updatedAt:'updated_at'});
