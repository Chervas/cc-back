'use strict';
module.exports=(s,D)=>s.define('SecurityMonitoringChange',{id:{type:D.INTEGER.UNSIGNED,autoIncrement:true,primaryKey:true},entity_type:D.STRING(40),entity_id:D.STRING(160),action:D.STRING(40),actor_id:D.INTEGER,detail:D.JSON},{tableName:'SecurityMonitoringChanges',underscored:true,createdAt:'created_at',updatedAt:'updated_at'});
