'use strict';
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingOAuthSlot',{
  scope_key:{type:D.STRING(64),primaryKey:true,allowNull:false},
  connection_ref:{type:D.STRING(128),unique:true,allowNull:false},
  asset_ref:{type:D.STRING(128),unique:true,allowNull:false},
  app_id:{type:D.STRING(30),allowNull:false},clinic_ids:{type:D.TEXT,allowNull:false},scopes:{type:D.TEXT,allowNull:false},
  redirect_uri:{type:D.STRING(512),allowNull:false},expires_at:{type:D.DATE(3),allowNull:false},
  state:{type:D.ENUM('active','blocked'),allowNull:false},
},{tableName:'MetaMarketingOAuthSlots',timestamps:false});
