'use strict';
module.exports=(s,D)=>s.define('SecurityMonitoringSetting',{id:{type:D.INTEGER.UNSIGNED,autoIncrement:true,primaryKey:true},scope:{type:D.STRING(32),unique:true,allowNull:false},rules:{type:D.JSON,allowNull:false},updated_by:D.INTEGER},{tableName:'SecurityMonitoringSettings',underscored:true,createdAt:'created_at',updatedAt:'updated_at'});
