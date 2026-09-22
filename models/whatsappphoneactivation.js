'use strict';
module.exports=(sequelize,D)=>sequelize.define('WhatsappPhoneActivation',{
  authorization_id:{type:D.STRING(36),primaryKey:true,allowNull:false},asset_id:{type:D.INTEGER,allowNull:false},
  scope_type:{type:D.STRING(16),allowNull:false},scope_id:{type:D.INTEGER,allowNull:false},clinic_ids:{type:D.JSON,allowNull:false},
  connection_ref:{type:D.STRING(128),allowNull:false},phone_id:{type:D.STRING(30),allowNull:false},waba_id:{type:D.STRING(30),allowNull:false},
  state:{type:D.STRING(32),allowNull:false},profile:{type:D.JSON,allowNull:false},message_not_before:{type:D.DATE(3),allowNull:false},
  updated_by:{type:D.INTEGER,allowNull:false},
},{tableName:'WhatsappPhoneActivations',timestamps:true,createdAt:'created_at',updatedAt:'updated_at'});
